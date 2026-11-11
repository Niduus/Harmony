fn main() {
    // The release workflow sets HARMONY_TAG so the exe knows which release it is.
    println!("cargo:rerun-if-env-changed=HARMONY_TAG");
    tauri_build::build()
}
