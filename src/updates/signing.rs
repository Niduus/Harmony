//! Release signatures. Every Harmony update is signed in CI with an Ed25519 key whose
//! private half lives only in a GitHub Actions secret. The public half is built into the
//! app (`update-key.pub`), and the updater refuses anything that doesn't verify.
//!
//! What gets signed binds the file to its release tag, so an old signed installer can't be
//! passed off as a newer release:  "harmony-release-v1\n<tag>\n<sha256 of the file, hex>"

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

pub fn signed_message(tag: &str, file: &[u8]) -> Vec<u8> {
    format!("harmony-release-v1\n{tag}\n{}", hex(&Sha256::digest(file))).into_bytes()
}

#[allow(dead_code)] // used by the harmony-sign tool
pub fn sign(secret_hex: &str, tag: &str, file: &[u8]) -> Result<String, String> {
    let bytes: [u8; 32] = unhex(secret_hex).and_then(|b| b.try_into().ok()).ok_or("The signing key must be 64 hex characters.")?;
    let key = SigningKey::from_bytes(&bytes);
    Ok(hex(&key.sign(&signed_message(tag, file)).to_bytes()))
}

#[allow(dead_code)] // used by the app and harmony-sign, not harmony-keygen
pub fn verify(public_hex: &str, tag: &str, file: &[u8], signature_hex: &str) -> Result<(), String> {
    let public: [u8; 32] = unhex(public_hex).and_then(|b| b.try_into().ok()).ok_or("This build has no update key, so it can't check updates.")?;
    let key = VerifyingKey::from_bytes(&public).map_err(|_| "This build's update key is invalid.")?;
    let sig: [u8; 64] = unhex(signature_hex).and_then(|b| b.try_into().ok()).ok_or("The update's signature is malformed.")?;
    key.verify(&signed_message(tag, file), &Signature::from_bytes(&sig))
        .map_err(|_| "The update's signature doesn't match. It was not installed.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify() {
        let secret = hex(&[7u8; 32]);
        let public = hex(SigningKey::from_bytes(&[7u8; 32]).verifying_key().as_bytes());
        let sig = sign(&secret, "harmony-v0.2.5", b"installer").unwrap();
        assert!(verify(&public, "harmony-v0.2.5", b"installer", &sig).is_ok());
        // A different file, or the same file under another tag, fails.
        assert!(verify(&public, "harmony-v0.2.5", b"tampered", &sig).is_err());
        assert!(verify(&public, "harmony-v0.2.9", b"installer", &sig).is_err());
        assert!(verify("not-configured", "harmony-v0.2.5", b"installer", &sig).is_err());
    }
}
