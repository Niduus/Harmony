//! Makes Harmony's update-signing key. Run once:  cargo run --release --bin harmony-keygen
//!
//! It writes the public key to update-key.pub (commit that file) and prints the private key
//! once. Put the private key in the repo's GitHub Actions secrets as HARMONY_SIGNING_KEY and
//! keep no other copy you don't need. Anyone with it can sign updates.

#[path = "../updates/signing.rs"]
mod signing;

fn main() {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).expect("no system randomness");
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public = signing::hex(key.verifying_key().as_bytes());
    std::fs::write("update-key.pub", format!("{public}\n")).expect("could not write update-key.pub");
    println!("Wrote update-key.pub. Commit it.\n");
    println!("Private key (add it as the GitHub Actions secret HARMONY_SIGNING_KEY, then close this window):\n");
    println!("{}", signing::hex(&seed));
}
