use std::{
    collections::BTreeMap,
    ffi::CString,
    fs, io,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
    path::Path,
};

use serde_json::{json, Value};

const TARGET_PID: u32 = 1;
const MAX_STATUS_BYTES: usize = 64 * 1024;
const MAX_MOUNT_INFO_BYTES: usize = 1024 * 1024;
const MAX_FILE_DESCRIPTORS: usize = 256;
const STATUS_FIELDS: [&str; 15] = [
    "Name",
    "State",
    "Tgid",
    "Pid",
    "PPid",
    "TracerPid",
    "Uid",
    "Gid",
    "Groups",
    "CapInh",
    "CapPrm",
    "CapEff",
    "CapBnd",
    "CapAmb",
    "NoNewPrivs",
];

pub(crate) fn collect_runtime_attestation() -> io::Result<Value> {
    let proc_root = format!("/proc/{TARGET_PID}");
    let status_text = read_bounded_text(
        Path::new(&proc_root).join("status"),
        MAX_STATUS_BYTES,
        "process status",
    )?;
    let mut status = select_status_fields(&status_text)?;
    for field in ["Seccomp", "Seccomp_filters"] {
        let value = status_value(&status_text, field)?;
        status.insert(field.to_string(), value.to_string());
    }

    let mount_info = read_bounded_text(
        Path::new(&proc_root).join("mountinfo"),
        MAX_MOUNT_INFO_BYTES,
        "mountinfo",
    )?;
    let file_descriptors = collect_file_descriptors(&proc_root)?;
    let paths = ["/", "/usr", "/usr/local", "/usr/local/bin", "/tmp"]
        .into_iter()
        .map(path_attestation)
        .chain(std::iter::once(path_attestation(
            "/usr/local/bin/cinatoken-container-runtime",
        )))
        .collect::<io::Result<Vec<_>>>()?;

    Ok(json!({
        "schemaVersion": 1,
        "contract": "cinatoken-container-runtime-process-attestation-v1",
        "targetPid": TARGET_PID,
        "status": status,
        "links": {
            "cwd": read_link_utf8(Path::new(&proc_root).join("cwd"))?,
            "executable": read_link_utf8(Path::new(&proc_root).join("exe"))?,
            "root": read_link_utf8(Path::new(&proc_root).join("root"))?,
        },
        "mountInfo": mount_info,
        "fileDescriptors": file_descriptors,
        "paths": paths,
    }))
}

fn read_bounded_text(
    path: impl AsRef<Path>,
    maximum_bytes: usize,
    label: &str,
) -> io::Result<String> {
    let bytes = fs::read(path)?;
    if bytes.len() > maximum_bytes {
        return Err(invalid_data(format!("{label} exceeded its byte limit")));
    }
    String::from_utf8(bytes).map_err(|_| invalid_data(format!("{label} was not UTF-8")))
}

fn select_status_fields(text: &str) -> io::Result<BTreeMap<String, String>> {
    STATUS_FIELDS
        .into_iter()
        .map(|field| Ok((field.to_string(), status_value(text, field)?.to_string())))
        .collect()
}

fn status_value<'a>(text: &'a str, field: &str) -> io::Result<&'a str> {
    text.lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name == field).then(|| value.trim())
        })
        .ok_or_else(|| invalid_data(format!("process status omitted {field}")))
}

fn collect_file_descriptors(proc_root: &str) -> io::Result<Vec<Value>> {
    let directory = Path::new(proc_root).join("fd");
    let mut descriptors = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            return Err(invalid_data("file descriptor name was not UTF-8"));
        };
        let Ok(fd) = name.parse::<u32>() else {
            continue;
        };
        let target = match fs::read_link(entry.path()) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let Some(target) = target.to_str() else {
            return Err(invalid_data("file descriptor target was not UTF-8"));
        };
        descriptors.push(json!({
            "fd": fd,
            "target": target,
        }));
        if descriptors.len() > MAX_FILE_DESCRIPTORS {
            return Err(invalid_data("file descriptor inventory exceeded its limit"));
        }
    }
    descriptors.sort_by_key(|entry| entry["fd"].as_u64().unwrap_or(u64::MAX));
    Ok(descriptors)
}

fn path_attestation(path: &str) -> io::Result<Value> {
    let metadata = fs::symlink_metadata(path)?;
    let file_type = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else if metadata.file_type().is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let acl_names = list_extended_attribute_names(Path::new(path))?;

    Ok(json!({
        "path": path,
        "fileType": file_type,
        "uid": metadata.uid(),
        "gid": metadata.gid(),
        "mode": format!("{:04o}", metadata.mode() & 0o7777),
        "linkCount": metadata.nlink(),
        "size": metadata.size(),
        "posixAclAccess": acl_names.iter().any(|name| name == b"system.posix_acl_access"),
        "posixAclDefault": acl_names.iter().any(|name| name == b"system.posix_acl_default"),
    }))
}

fn list_extended_attribute_names(path: &Path) -> io::Result<Vec<Vec<u8>>> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid_data("attested path contained NUL"))?;
    let required = unsafe { libc::listxattr(path.as_ptr(), std::ptr::null_mut(), 0) };
    if required < 0 {
        return Err(io::Error::last_os_error());
    }
    if required == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = vec![0_u8; required as usize];
    let written =
        unsafe { libc::listxattr(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(written as usize);
    Ok(buffer
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn read_link_utf8(path: impl AsRef<Path>) -> io::Result<String> {
    fs::read_link(path)?
        .into_os_string()
        .into_string()
        .map_err(|_| invalid_data("process link target was not UTF-8"))
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
