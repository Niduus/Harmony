//! Makes Harmony's update-signing key. Run it once: double-click harmony-keygen.exe (from the
//! test release), or `cargo run --release --bin harmony-keygen`.
//!
//! It shows the public key (commit it as update-key.pub; it also writes that file) and the
//! private key, once. The private key goes into the repo's GitHub Actions secret
//! HARMONY_SIGNING_KEY and nowhere else: anyone with it can sign updates.

#[path = "../signing.rs"]
mod signing;

fn main() {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("no system randomness");
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public = signing::hex(key.verifying_key().as_bytes());
    let _ = std::fs::write("update-key.pub", format!("{public}\n"));
    println!("Harmony update-signing key\n");
    println!("1. Open https://github.com/Niduus/Harmony/settings/secrets/actions/new");
    println!("   Name: HARMONY_SIGNING_KEY");
    println!("   Secret (the PRIVATE key, shown only this once; paste it nowhere else):\n");
    println!("   {}\n", signing::hex(&seed));
    println!("2. Send this PUBLIC key to Claude (safe to share), or commit it as update-key.pub:\n");
    println!("   {public}\n");
    println!("Running this again makes a different key, so finish both steps with this one.");
    println!("Press Enter to close. The private key disappears with this window.");
    let _ = std::io::stdin().read_line(&mut String::new());
}
