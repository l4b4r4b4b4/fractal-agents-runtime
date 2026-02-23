# Task-01: Research & Cryptographic Protocol Design

> **Status**: 🟢 Complete (research phase — living document)
> **Phase**: 1 — Foundation
> **Updated**: 2026-02-23

## Objective

Define the complete cryptographic protocol for hardware key encryption, including key hierarchy, all flows (registration, encryption, decryption, multi-party), threat model, and library selections.

## Protocol Design

### Key Hierarchy

```
Hardware Key (FIDO2 authenticator)
  └─ PRF Output (32 bytes, per-credential, deterministic for same salt)
       └─ HKDF-SHA256 (salt=credential_id, info=context_string)
            └─ KEK (Key Encryption Key) — 256-bit AES key
                 └─ Wraps DEK (Data Encryption Key) per asset
                      └─ AES-256-GCM encrypts actual payload
```

**Why two layers (KEK → DEK)?**
- Key rotation: re-wrap DEK with new KEK without re-encrypting payload
- Multi-party: each party's KEK wraps the same DEK via Shamir shares
- Revocation: remove one user's wrapped DEK copy without touching ciphertext

### Flow 1: Hardware Key Registration

```
Client                              Server (Edge Function)           Postgres
──────                              ──────────────────────           ────────
1. navigator.credentials.create({
     publicKey: {
       rp: { name, id },
       user: { id, name },
       challenge: <from server>,
       pubKeyCredParams: [ES256, RS256],
       extensions: { prf: {} }      ← Request PRF support detection
     }
   })
                                    2. Verify attestation response
                                       - Check origin, rpIdHash
                                       - Verify signature
                                       - Extract public key (COSE)
                                       - Extract AAGUID
                                       - Check PRF support in extensions
                                                                     3. INSERT hardware_keys
                                                                        (credential_id, public_key,
                                                                         counter=0, transports,
                                                                         aaguid, attestation_format,
                                                                         device_type from AAGUID DB)
                                    4. Return { key_id, prf_supported }
```

### Flow 2: Single-User Encryption

```
Client
──────
1. navigator.credentials.get({
     publicKey: {
       challenge: crypto.getRandomValues(32),
       allowCredentials: [{ id: credential_id }],
       extensions: {
         prf: {
           eval: {
             first: new TextEncoder().encode(
               `encrypt:${asset_type}:${asset_id}`
             )
           }
         }
       }
     }
   })

2. prf_output = response.getClientExtensionResults().prf.results.first
   // 32 bytes, deterministic for (credential, salt)

3. kek = await crypto.subtle.importKey("raw", 
     await crypto.subtle.deriveBits(
       { name: "HKDF", hash: "SHA-256",
         salt: credential_id_bytes,
         info: encode("fractal:kek:v1") },
       prf_key, 256
     ), "AES-GCM", false, ["wrapKey", "unwrapKey"])

4. dek = await crypto.subtle.generateKey(
     { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])

5. iv = crypto.getRandomValues(12)
   ciphertext = await crypto.subtle.encrypt(
     { name: "AES-GCM", iv }, dek, plaintext)

6. wrapped_dek = await crypto.subtle.wrapKey("raw", dek, kek,
     { name: "AES-GCM", iv: wrap_iv })

7. POST /encrypted-assets {
     asset_type, asset_id,
     encrypted_payload: ciphertext,
     initialization_vector: iv,
     encryption_algorithm: "AES-GCM-256",
     key_derivation_method: "webauthn-prf-hkdf",
     authorized_key_ids: [hardware_key_uuid],
     wrapped_dek: wrapped_dek,       // stored alongside or in metadata
     wrap_iv: wrap_iv
   }
```

### Flow 3: Single-User Decryption

```
Client                              Server (Runtime)                 Postgres
──────                              ────────────────                 ────────
1. Request protected asset
                                    2. Check has_key_protected_access()
                                       → Policy exists? Need assertion?
                                    3. Return 403 + { requires_key: true,
                                       challenge: random_bytes(32) }

4. navigator.credentials.get({
     extensions: { prf: { eval: {
       first: encode(`decrypt:${asset_type}:${asset_id}`)
     }}}
   })

5. POST /keys/verify-assertion {
     assertion_response,             ← WebAuthn assertion JSON
     asset_type, asset_id,
     challenge
   }
                                    6. Edge Function:
                                       - Verify signature vs stored public_key
                                       - Increment counter (clone detect)
                                       - INSERT key_assertions (5-min TTL)
                                    7. Return { assertion_id, expires_at }

8. Derive KEK from PRF output (same HKDF as encryption)
9. Unwrap DEK using KEK
10. Decrypt ciphertext with DEK
11. Use plaintext locally
```

### Flow 4: Multi-Party Decryption (Shamir SSS)

```
Encryption (by creator):
  1. Generate DEK
  2. Encrypt payload with DEK
  3. Split DEK into N shares (threshold T)
  4. For each authorized user's hardware key:
     - Derive their KEK from their PRF output
     - Wrap their DEK share with their KEK
  5. Store wrapped shares in encrypted_asset_data

Decryption (requires T of N users):
  1. Each participant touches their hardware key
  2. Each derives their KEK, unwraps their share
  3. T shares are submitted to reconstruction endpoint
  4. Server (or client-side) recombines T shares → DEK
  5. DEK decrypts payload
  6. DEK is zeroized immediately after use
```

### Flow 5: Key Assertion for Server-Side Operations

For operations where the server needs to verify key presence but decryption
happens client-side (the common case):

```
1. Client touches key → assertion response
2. Runtime POST to Edge Function → verified, INSERT key_assertions
3. Runtime checks has_key_protected_access() → true (valid assertion exists)
4. Runtime proceeds with operation (e.g., DELETE, SHARE, EXPORT)
5. Runtime marks assertion consumed (consumed=true, consumed_at=now())
```

## Technology Selections

### Client-Side Libraries

| Library | Purpose | Rationale |
|---------|---------|-----------|
| `@simplewebauthn/browser` | WebAuthn ceremony (registration + assertion) | Most popular, well-maintained, TypeScript-first |
| `Web Crypto API` (native) | AES-GCM encrypt/decrypt, HKDF key derivation | Browser-native, no dependencies, hardware-accelerated |
| `@noble/ciphers` | Fallback ChaCha20-Poly1305 if needed | Audited, zero-dependency, pure JS |
| `@noble/hashes` | HKDF, SHA-256 if Web Crypto insufficient | Same author/audit as above |
| `shares.js` or custom | Shamir's Secret Sharing | Evaluate: audrey-field/shamir, jwerle/shamirs-secret-sharing |

### Server-Side Libraries (Python)

| Library | Purpose | Rationale |
|---------|---------|-----------|
| `py_webauthn` | WebAuthn assertion verification | Official FIDO Alliance recommended, well-maintained |
| `cryptography` | AES-GCM, HKDF, key management | OpenSSL-backed, widely audited, already likely in deps |
| `pysodium` or `PyNaCl` | Optional: XChaCha20-Poly1305, secret sharing | libsodium bindings, battle-tested |

### Server-Side Libraries (TypeScript)

| Library | Purpose | Rationale |
|---------|---------|-----------|
| `@simplewebauthn/server` | WebAuthn verification server-side | Companion to browser lib |
| `Web Crypto API` (Bun native) | Same as browser — Bun supports it | Zero deps |

## Threat Model Summary

### Assets Protected
- Chat message history (primary)
- Documents / document artifacts
- Agent configurations (system prompts)
- Processing results

### Threat Actors
1. **Compromised server** — Attacker has DB access but not hardware keys → cannot decrypt (encrypted_payload is opaque)
2. **Compromised client** — Attacker has session but not physical key → cannot produce PRF output
3. **Insider (admin)** — Has DB access, can see ciphertext → same as #1
4. **Network eavesdropper** — TLS protects transport, key material never sent in plaintext
5. **Cloned key** — Counter check detects; policy can require specific key IDs

### What We Do NOT Protect Against
- Physical compromise of hardware key + access to user's browser session simultaneously
- Side-channel attacks on Web Crypto API (browser vendor responsibility)
- Quantum computing (future — revisit with PQC)

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary cipher | AES-256-GCM | Universal HW support, Web Crypto native, authenticated |
| KDF | HKDF-SHA256 | Standard, fast, Web Crypto native |
| PRF salt strategy | `{action}:{asset_type}:{asset_id}` | Domain separation per asset+action |
| Key hierarchy | KEK → DEK | Enables rotation and multi-party without re-encryption |
| Assertion TTL | 5 minutes | Balance between UX (not too short) and security (not too long) |
| Assertion model | Single-use (consumed flag) | Prevents replay; consumed_at for audit |
| Multi-party scheme | Shamir's Secret Sharing | Well-understood, threshold flexibility, no trusted dealer needed if done client-side |

## Open Questions (To Resolve During Implementation)

- [ ] Where does the wrapped DEK live? Options: (a) column on encrypted_asset_data, (b) separate `wrapped_deks` table with one row per authorized user, (c) JSONB metadata column. **Recommendation: (b) for multi-party, (a) sufficient for single-user MVP.**
- [ ] Should PRF salt include a version/rotation nonce? Probably yes for key rotation.
- [ ] Edge Function vs. Runtime for assertion INSERT — Edge Function is the plan per schema design (no INSERT RLS on key_assertions). Runtime calls Edge Function via HTTP.
- [ ] Client-side vs. server-side Shamir reconstruction — client-side is more secure (server never sees DEK), but requires all T participants to be online simultaneously.