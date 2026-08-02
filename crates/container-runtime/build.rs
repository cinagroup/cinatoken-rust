use std::{env, error::Error, fs, path::PathBuf};

use prost::Message;
use prost_types::FileDescriptorSet;

fn main() -> Result<(), Box<dyn Error>> {
    let descriptor_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?)
        .join("../../contracts/container-runtime/v1/generated/container-runtime.pb");
    println!("cargo:rerun-if-changed={}", descriptor_path.display());

    let descriptor = FileDescriptorSet::decode(fs::read(descriptor_path)?.as_slice())?;
    prost_build::Config::new().compile_fds(descriptor)?;
    Ok(())
}
