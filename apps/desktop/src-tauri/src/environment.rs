// A project's preview environment lives in the OS keychain, never in
// ~/.nautilus/state.json. The webview reads it back only to edit it and to
// send it to the runner; the runner's copy is write-only.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "nautilus";

// Windows caps one credential at 2560 bytes of UTF-16, so a project's document
// is split across numbered entries. 600 characters fit even when every one
// takes four bytes. The bare account holds how many entries there are.
const CHUNK_CHARS: usize = 600;

const MAX_KEYS: usize = 200;
const MAX_TOTAL_BYTES: usize = 64 * 1024;
const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 50_000;

// Matches packages/shadow-git ignoredNames: nothing in these folders syncs, so
// nothing in them is the project's own configuration either.
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "coverage",
    ".turbo",
    ".vite",
    ".nautilus",
    "target",
    ".svelte-kit",
    ".nuxt",
    ".output",
    ".parcel-cache",
    ".cache",
    "__pycache__",
    ".venv",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
    ".terraform",
];

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    variables: BTreeMap<String, String>,
    // A digest per variable the runner last accepted, so a push can tell which
    // keys changed without the runner ever returning values.
    #[serde(default)]
    sent: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    variables: BTreeMap<String, String>,
    sent: BTreeMap<String, String>,
    keychain: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    keychain: bool,
}

#[derive(Serialize)]
pub struct ScannedKey {
    name: String,
    value: Option<String>,
}

#[derive(Serialize)]
pub struct ScannedFile {
    path: String,
    keys: Vec<ScannedKey>,
}

fn valid_project_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

fn valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn validate(variables: &BTreeMap<String, String>) -> Result<(), String> {
    if variables.len() > MAX_KEYS {
        return Err(format!("A project can have at most {MAX_KEYS} variables."));
    }
    let mut total = 0;
    for (key, value) in variables {
        if !valid_key(key) {
            return Err(format!("{key} is not a valid variable name."));
        }
        if value.contains('\0') {
            return Err(format!("{key} contains a null character."));
        }
        total += key.len() + value.len();
    }
    if total > MAX_TOTAL_BYTES {
        return Err("The variables add up to more than 64 KB.".into());
    }
    Ok(())
}

fn account(project_id: &str) -> String {
    format!("env:{project_id}")
}

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account)
}

fn keychain_read(project_id: &str) -> keyring::Result<Option<String>> {
    let head = account(project_id);
    let count = match entry(&head)?.get_password() {
        Ok(count) => count,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error),
    };
    let count: usize = count
        .parse()
        .map_err(|_| keyring::Error::Invalid(head.clone(), "chunk count".into()))?;
    let mut document = String::new();
    for index in 0..count {
        document.push_str(&entry(&format!("{head}#{index}"))?.get_password()?);
    }
    Ok(Some(document))
}

fn keychain_delete(project_id: &str) -> keyring::Result<()> {
    let head = account(project_id);
    let count = match entry(&head)?.get_password() {
        Ok(count) => count.parse::<usize>().unwrap_or(0),
        Err(keyring::Error::NoEntry) => return Ok(()),
        Err(error) => return Err(error),
    };
    for index in 0..count {
        match entry(&format!("{head}#{index}"))?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error),
        }
    }
    match entry(&head)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}

fn keychain_write(project_id: &str, document: &str) -> keyring::Result<()> {
    keychain_delete(project_id)?;
    let head = account(project_id);
    let chars: Vec<char> = document.chars().collect();
    let chunks: Vec<String> = chars
        .chunks(CHUNK_CHARS)
        .map(|chunk| chunk.iter().collect())
        .collect();
    for (index, chunk) in chunks.iter().enumerate() {
        entry(&format!("{head}#{index}"))?.set_password(chunk)?;
    }
    // The count goes last, so a write cut short reads as no entry, not a
    // truncated document.
    entry(&head)?.set_password(&chunks.len().to_string())
}

fn home(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().home_dir().map_err(|error| error.to_string())
}

fn fallback_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    Ok(home(app)?
        .join(".nautilus")
        .join("env")
        .join(format!("{project_id}.json")))
}

fn fallback_read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn fallback_write(path: &Path, document: &str) -> Result<(), String> {
    let directory = path.parent().ok_or("invalid fallback path")?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(document.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn parse_document(contents: &str) -> Result<Document, String> {
    serde_json::from_str(contents).map_err(|_| "The saved variables could not be read.".into())
}

#[tauri::command]
pub fn env_load(app: AppHandle, project_id: String) -> Result<Loaded, String> {
    if !valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let fallback = fallback_path(&app, &project_id)?;
    let (contents, keychain) = match keychain_read(&project_id) {
        Ok(Some(contents)) => (Some(contents), true),
        // An earlier save may have fallen back to the file while the keychain
        // was locked or missing.
        Ok(None) => {
            let contents = fallback_read(&fallback)?;
            let keychain = contents.is_none();
            (contents, keychain)
        }
        Err(_) => (fallback_read(&fallback)?, false),
    };
    let document = match contents {
        Some(contents) => parse_document(&contents)?,
        None => Document::default(),
    };
    Ok(Loaded {
        variables: document.variables,
        sent: document.sent,
        keychain,
    })
}

#[tauri::command]
pub fn env_save(
    app: AppHandle,
    project_id: String,
    variables: BTreeMap<String, String>,
    sent: BTreeMap<String, String>,
) -> Result<Saved, String> {
    if !valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    validate(&variables)?;
    let document =
        serde_json::to_string(&Document { variables, sent }).map_err(|error| error.to_string())?;
    let fallback = fallback_path(&app, &project_id)?;
    match keychain_write(&project_id, &document) {
        Ok(()) => {
            let _ = fs::remove_file(&fallback);
            Ok(Saved { keychain: true })
        }
        Err(_) => {
            fallback_write(&fallback, &document)?;
            Ok(Saved { keychain: false })
        }
    }
}

#[tauri::command]
pub fn env_delete(app: AppHandle, project_id: String) -> Result<(), String> {
    if !valid_project_id(&project_id) {
        return Err("invalid project id".into());
    }
    let _ = keychain_delete(&project_id);
    match fs::remove_file(fallback_path(&app, &project_id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

// Only folders the user added as projects can be scanned, so the webview cannot
// use this command to read env files anywhere else on the PC.
fn registered_project(app: &AppHandle, requested: &Path) -> Result<PathBuf, String> {
    let home = home(app)?;
    let requested = fs::canonicalize(expand_home(requested, &home))
        .map_err(|_| "The project folder is missing.")?;
    let state = fs::read_to_string(home.join(".nautilus").join("state.json"))
        .map_err(|_| "The project is not registered on this PC.")?;
    let state: serde_json::Value =
        serde_json::from_str(&state).map_err(|_| "~/.nautilus/state.json is not valid JSON")?;
    let registered = state["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|project| project["localPath"].as_str())
        .filter_map(|path| fs::canonicalize(expand_home(Path::new(path), &home)).ok())
        .any(|path| path == requested);
    if registered {
        Ok(requested)
    } else {
        Err("The project is not registered on this PC.".into())
    }
}

// state.json keeps project folders as the user picked them, often as
// "~/projects/app", which the file system does not resolve by itself.
fn expand_home(path: &Path, home: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Ok(rest) => home.join(rest),
        Err(_) => path.to_path_buf(),
    }
}

pub fn is_env_file(name: &str) -> bool {
    name == ".env"
        || name.starts_with(".env.")
        || name == ".dev.vars"
        || name.starts_with(".dev.vars.")
}

// Files that document a project's variables rather than set them.
fn is_template(name: &str) -> bool {
    [".example", ".sample", ".template"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

fn unquote(raw: &str) -> String {
    let value = raw.trim();
    for quote in ['"', '\'', '`'] {
        if value.len() >= 2 && value.starts_with(quote) {
            if let Some(end) = value[1..].find(quote) {
                let inner = &value[1..=end];
                return if quote == '"' {
                    inner.replace("\\n", "\n").replace("\\\"", "\"")
                } else {
                    inner.to_string()
                };
            }
        }
    }
    // An unquoted value ends at a comment that follows whitespace.
    match value.find(" #") {
        Some(index) => value[..index].trim_end().to_string(),
        None => value.to_string(),
    }
}

pub fn parse_dotenv(contents: &str) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut lines = contents.lines();
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !valid_key(key) {
            continue;
        }
        let mut raw = raw.trim().to_string();
        // A double-quoted value may span lines until its closing quote.
        if raw.starts_with('"') && raw[1..].find('"').is_none() {
            for next in lines.by_ref() {
                raw.push('\n');
                raw.push_str(next);
                if next.contains('"') {
                    break;
                }
            }
        }
        let value = unquote(&raw);
        match entries.iter_mut().find(|(existing, _)| existing == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key.to_string(), value)),
        }
    }
    entries
}

fn scan(root: &Path) -> Vec<ScannedFile> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let entries: Vec<_> = entries.flatten().collect();
        if directory != root && entries.iter().any(|entry| entry.file_name() == ".git") {
            continue;
        }
        for entry in entries {
            seen += 1;
            if seen > MAX_SCAN_ENTRIES {
                return files;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !IGNORED_DIRECTORIES.contains(&name.as_str()) {
                    pending.push(entry.path());
                }
                continue;
            }
            if !kind.is_file() || !is_env_file(&name) {
                continue;
            }
            if entry
                .metadata()
                .map(|meta| meta.len() > MAX_ENV_FILE_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(contents) = fs::read_to_string(entry.path()) else {
                continue;
            };
            let template = is_template(&name);
            let path = entry
                .path()
                .strip_prefix(root)
                .map(|path| path.to_string_lossy().replace('\\', "/"))
                .unwrap_or(name);
            files.push(ScannedFile {
                path,
                keys: parse_dotenv(&contents)
                    .into_iter()
                    .map(|(name, value)| ScannedKey {
                        name,
                        value: (!template).then_some(value),
                    })
                    .collect(),
            });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

#[tauri::command]
pub async fn env_scan(app: AppHandle, project_path: String) -> Result<Vec<ScannedFile>, String> {
    let root = registered_project(&app, Path::new(&project_path))?;
    tauri::async_runtime::spawn_blocking(move || scan(&root))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_a_leading_tilde_only() {
        let home = Path::new("/home/user");
        assert_eq!(
            expand_home(Path::new("~/Desktop/app"), home),
            PathBuf::from("/home/user/Desktop/app")
        );
        assert_eq!(expand_home(Path::new("~"), home), PathBuf::from("/home/user"));
        assert_eq!(
            expand_home(Path::new("/srv/app"), home),
            PathBuf::from("/srv/app")
        );
        assert_eq!(expand_home(Path::new("~other/app"), home), PathBuf::from("~other/app"));
    }

    #[test]
    fn parses_dotenv_lines() {
        let parsed = parse_dotenv(
            "# comment\nexport A=1\nB = \"two words\" \nC='x # y'\nD=plain # note\nnot a line\n1BAD=x\nE=\"multi\nline\"\nA=override\n",
        );
        assert_eq!(
            parsed,
            vec![
                ("A".into(), "override".into()),
                ("B".into(), "two words".into()),
                ("C".into(), "x # y".into()),
                ("D".into(), "plain".into()),
                ("E".into(), "multi\nline".into()),
            ]
        );
    }

    #[test]
    fn recognizes_env_files() {
        for name in [
            ".env",
            ".env.local",
            ".env.example",
            ".dev.vars",
            ".dev.vars.staging",
        ] {
            assert!(is_env_file(name), "{name}");
        }
        for name in [".envrc", "env", "foo.env", ".environment"] {
            assert!(!is_env_file(name), "{name}");
        }
        assert!(is_template(".env.example"));
        assert!(!is_template(".env.local"));
    }

    #[test]
    fn validates_variables() {
        let mut variables = BTreeMap::new();
        variables.insert("GOOD_1".to_string(), "x".to_string());
        assert!(validate(&variables).is_ok());
        variables.insert("1BAD".to_string(), "x".to_string());
        assert!(validate(&variables).is_err());
    }
}
