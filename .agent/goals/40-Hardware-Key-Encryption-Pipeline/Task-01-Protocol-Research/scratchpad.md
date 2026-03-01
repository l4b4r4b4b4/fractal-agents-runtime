# Task-01: Protocol Research & Cryptographic Architecture

> **Status**: 🟢 Complete
> **Phase**: 1 — Foundation
> **Updated**: 2026-02-23

## Objective

Research and document the cryptographic protocol design for hardware key encryption, including key hierarchy, WebAuthn PRF integration, multi-party decryption, and threat model.

## Research Findings

### WebAuthn PRF Extension

- **What it is**: WebAuthn Level 3 PRF (Pseudo-Random Function) extension allows deriving deterministic symmetric key material from a hardware authenticator during `navigator.credentials.get()`.
- **Browser support**: Chrome 116+, Edge 116+. Firefox/Safari patchy as of early 2026.
- **How it works**: Client sends a salt to the authenticator via `extensions.prf.eval.first`; authenticator returns HMAC-SHA-256 output using its internal secret. This output is never the same as the HMAC-secret used for FIDO2 auth — it's a separate derivation.
- **Key derivation chain**: `PRF output (32 bytes) → HKDF-SHA-256(salt, info) → AES-256-GCM key`

### Key Hierarchy

```
Hardware Key (FIDO2 authenticator)
  └─ PRF output (per-salt, deterministic)
       └─ HKDF-SHA-256 → KEK (Key Encryption Key)
            └─ Wraps DEK (Data Encryption Key, random per asset)
                 └─ AES-256-GCM encrypts asset payload
```

- **KEK** (Key Encryption Key): Derived from hardware key PRF. Never stored. Reconstructed on each assertion.
- **DEK** (Data Encryption Key): Random 256-bit key, wrapped (encrypted) by KEK. Stored alongside ciphertext in `encrypted_asset_data`.
- **Why two layers**: Enables key rotation (re-wrap DEK with new KEK) without re-encrypting all data. Enables multi-key access (same DEK wrapped by multiple KEKs).

### Single-User Encryption Flow

1. User taps hardware key → browser calls `navigator.credentials.get()` with PRF extension
2. PRF output → HKDF → KEK
3. Generate random DEK → encrypt payload with DEK (AES-256-GCM)
4. Wrap DEK with KEK → store (wrapped_DEK + ciphertext + IV) in `encrypted_asset_data`
5. To decrypt: tap key again → reconstruct KEK → unwrap DEK → decrypt payload

### Multi-Party Decryption (Shamir's Secret Sharing)

- **Approach**: DEK is split into N shares using Shamir's Secret Sharing (SSS). Each share is wrapped by a different user's KEK.
- **Threshold**: M-of-N shares required to reconstruct DEK.
- **Flow**: Each participant taps their key → PRF → KEK → unwrap their share → when M shares collected, reconstruct DEK → decrypt.
- **Storage**: Each share is stored as a separate `encrypted_asset_data` row with the participant's `authorized_key_ids`.

### Secure Transport

- Key material (PRF output, unwrapped shares) MUST NOT transit in plaintext.
- **JWE (JSON Web Encryption)**: Used to encrypt key material in transit between client and server Edge Function.
- **Server-side**: Edge Function verifies assertion, stores `key_assertions` record. Runtime checks assertion validity via `has_key_protected_access()`.

### Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| Stolen JWT | Key assertions are separate from JWT auth — stolen JWT cannot bypass hardware key requirement |
| Replay attack | Challenge stored in `key_assertions`, single-use (`consumed` flag) |
| Cloned hardware key | Counter verification (`hardware_keys.counter` must monotonically increase) |
| Server compromise | Server never sees plaintext key material — encryption/decryption is client-side. Server stores only ciphertext + wrapped keys |
| Lost hardware key | Backup key registration, recovery via second authorized key |
| Database dump | Ciphertext without KEK is useless. KEK requires physical hardware key |
| Memory dump on server | Key material only exists in Edge Function memory during assertion verification (~ms). Runtime never handles raw key material |

### Technology Choices

**Client-Side:**
- `navigator.credentials` (WebAuthn API) for key registration + assertion
- Web Crypto API (`crypto.subtle`) for AES-256-GCM, HKDF, key wrapping
- `@simplewebauthn/browser` for WebAuthn ceremony helpers

**Server-Side (Python):**
- `py_webauthn` for assertion verification in Edge Function
- `cryptography` library for any server-side crypto operations
- Supabase client for DB operations

**Server-Side (TypeScript):**
- `@simplewebauthn/server` for assertion verification
- Web Crypto API (native in Bun/Deno) for crypto operations

**Database:**
- `pgcrypto` (installed) for `gen_random_bytes()` challenge generation
- `supabase_vault` (installed) for any server-side secret storage
- `pg_cron` (available) for assertion cleanup scheduling

## Deliverables

- [x] Protocol design documented (this scratchpad)
- [x] Key hierarchy defined
- [x] Threat model outlined
- [x] Technology choices evaluated
- [x] Schema verified against protocol requirements (Task-02)