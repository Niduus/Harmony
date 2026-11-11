//! Signs a release file in CI:  harmony-sign <file> <tag>   (key in HARMONY_SIGNING_KEY)
//! Writes <file>.sig next to it.

#[path = "../updates/signing.rs"]
mod signing;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [file, tag] = args.as_slice() else {
        eprintln!("usage: harmony-sign <file> <tag>");
        std::process::exit(2);
    };
    let secret = std::env::var("HARMONY_SIGNING_KEY").unwrap_or_default();
    if secret.trim().is_empty() {
        eprintln!("HARMONY_SIGNING_KEY is not set. Releases are never published unsigned.");
        std::process::exit(1);
    }
    let bytes = std::fs::read(file).expect("could not read the file");
    let sig = signing::sign(&secret, tag, &bytes).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    // Catch a secret that doesn't match the key built into Harmony before anything is published:
    // installed copies would refuse such an update anyway.
    let public = std::fs::read_to_string("update-key.pub").unwrap_or_default();
    if let Err(e) = signing::verify(public.trim(), tag, &bytes, &sig) {
        eprintln!("The signature doesn't match update-key.pub ({e}). Check HARMONY_SIGNING_KEY.");
        std::process::exit(1);
    }
    std::fs::write(format!("{file}.sig"), format!("{sig}\n")).expect("could not write the signature");
    println!("Signed {file} as {tag}.");
}
