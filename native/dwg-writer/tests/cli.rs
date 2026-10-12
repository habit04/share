#![cfg(windows)]
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static WORKSPACE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Windows clock resolution can give parallel tests the same timestamp. The
        // process-wide sequence separates threads; an atomic create handles stale paths.
        for _ in 0..100 {
            let sequence = WORKSPACE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "jcad-writer-cli-test-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("Cannot create private CLI-test workspace: {error}"),
            }
        }
        panic!("Cannot allocate a unique private CLI-test workspace");
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("jcad-writer-cli-test-"));
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn input(record: &str) -> String {
    format!("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{record}0\nENDSEC\n0\nEOF\n")
}
fn command(work: &Workspace) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_JcadDwgWriter"));
    command.current_dir(&work.0);
    command
}

#[test]
fn refuses_each_retained_acis_type_with_bounded_report_and_no_output() {
    for kind in ["REGION", "3DSOLID", "BODY", "ACAD_SURFACE"] {
        let work = Workspace::new();
        fs::write(work.0.join("input.dxf"), input(&format!("0\n{kind}\n"))).unwrap();
        let result = command(&work)
            .args(["convert", "input.dxf", "output.dwg", "report.json"])
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(result.stderr.len() < 4096);
        assert!(result.stdout.is_empty());
        let report: serde_json::Value =
            serde_json::from_slice(&fs::read(work.0.join("report.json")).unwrap()).unwrap();
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["success"], false);
        assert!(report["errors"][0]
            .as_str()
            .unwrap()
            .contains("retained 3D/ACIS"));
        assert!(!work.0.join("output.dwg").exists());
    }
}

#[test]
fn rejects_arbitrary_filenames_without_touching_inputs_or_destinations() {
    let work = Workspace::new();
    let target = work.0.join("user-original.dwg");
    fs::write(&target, b"original").unwrap();
    let result = command(&work)
        .args(["convert", "input.dxf", "user-original.dwg", "report.json"])
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
    assert_eq!(fs::read(target).unwrap(), b"original");
    assert!(!work.0.join("report.json").exists());
}

#[test]
fn invalid_numeric_input_refuses_before_expensive_parse() {
    let work = Workspace::new();
    fs::write(work.0.join("input.dxf"), input("0\nLINE\n10\nNaN\n")).unwrap();
    let result = command(&work)
        .args(["convert", "input.dxf", "output.dwg", "report.json"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(work.0.join("report.json")).unwrap()).unwrap();
    assert!(report["errors"][0].as_str().unwrap().contains("number"));
    assert!(!work.0.join("output.dwg").exists());
}
