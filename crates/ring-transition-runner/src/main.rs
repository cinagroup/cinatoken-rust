use cinatoken_ring_transition_runner::{authorize_execution, describe, placement};

#[tokio::main]
async fn main() {
    let exit_code = match parse_command(std::env::args().skip(1)) {
        Ok(Command::Describe) => match serde_json::to_string_pretty(&describe()) {
            Ok(output) => {
                println!("{output}");
                0
            }
            Err(_) => {
                eprintln!("ring transition runner description failed closed");
                1
            }
        },
        Ok(Command::DescribePlacement) => {
            match serde_json::to_string_pretty(&placement::describe()) {
                Ok(output) => {
                    println!("{output}");
                    0
                }
                Err(_) => {
                    eprintln!("shard placement runner description failed closed");
                    1
                }
            }
        }
        Ok(Command::Execute) => match authorize_execution().await {
            Ok(_) => {
                eprintln!("ring transition identities verified; claim execution remains disabled");
                1
            }
            Err(error) => {
                eprintln!("{error}");
                1
            }
        },
        Err(error) => {
            eprintln!("{error}");
            2
        }
    };
    std::process::exit(exit_code);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Command {
    Describe,
    DescribePlacement,
    Execute,
}

fn parse_command(arguments: impl Iterator<Item = String>) -> Result<Command, &'static str> {
    let values: Vec<String> = arguments.collect();
    match values.as_slice() {
        [value] if value == "--describe" => Ok(Command::Describe),
        [value] if value == "--describe-placement" => Ok(Command::DescribePlacement),
        [value] if value == "--execute" => Ok(Command::Execute),
        _ => {
            Err("usage: cinatoken-ring-transition-runner --describe|--describe-placement|--execute")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_one_fixed_command() {
        assert_eq!(
            parse_command(["--describe".to_owned()].into_iter()),
            Ok(Command::Describe)
        );
        assert_eq!(
            parse_command(["--execute".to_owned()].into_iter()),
            Ok(Command::Execute)
        );
        assert_eq!(
            parse_command(["--describe-placement".to_owned()].into_iter()),
            Ok(Command::DescribePlacement)
        );
        for rejected in [
            vec![],
            vec!["--execute".to_owned(), "--config".to_owned()],
            vec!["--trust".to_owned()],
            vec!["--runner".to_owned()],
        ] {
            assert!(parse_command(rejected.into_iter()).is_err());
        }
    }
}
