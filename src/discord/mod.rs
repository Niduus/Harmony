//! Talking to Discord: the gateway websocket, the REST API, and turning Discord's messages
//! into what the window draws. Every call here is made by `core.rs`, after `safety.rs` allows it.

pub mod describe;
pub mod gateway;
pub mod rest;
