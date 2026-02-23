# Goal 40: Hardware Key Encryption Pipeline — End-to-End Asset Encryption with Hardware Keys

> **Status**: 🟡 In Progress
> **Priority**: P1 (High)
> **Created**: 2026-02-23
> **Updated**: 2026-02-23
> **Blocked By**: —

## Overview

Enable users to encrypt assets (messages, documents, chat history) using hardware security keys (FIDO2/YubiKey), with support for multi-party server-side decryption where multiple users' hardware keys must contribute key material to unlock shared assets. The decrypted content flows through the entire pipeline, including passing securely to vLLM for inference — achieving encryption at rest, in transit, and ideally in use.

## Success Criteria

- [ ] Users can register hardware keys with PRF (Pseudo-Random Function) extension support
- [ ] Users can encrypt assets client-side using keys derived from their hardware authenticator
- [ ] Encrypted assets are stored in Supabase with proper key metadata
- [ ] Multi-party decryption works: N-of-M hardware key holders must contribute to decrypt shared assets
- [ ] Key material is transported securely via JWT/JWE-secured channel
- [ ] Server-side decryption pipeline reconstructs keys and decrypts message history
- [ ] Live chat messages support real-time encryption/decryption with hardware keys
- [ ] Encrypted context is passed securely to vLLM with decryption at the inference boundary
- [ ] Key rotation and revocation workflows exist
- [ ] Full audit trail for all key operations

## Context & Background

### Why This Matters

The platform handles sensitive conversations (agent chats, potentially confidential business data). Users need assurance that:
1. **Their data is encrypted at rest** — not just database-level, but application-level encryption they control
2. **Only authorized parties can decrypt** — hardware keys provide non-extractable, phishing-resistant proof of identity
3. **Multi-party access control** — shared assets (e.g., team chat history) require agreement from multiple key holders
4. **The LLM never sees plaintext unnecessarily** — encryption extends as deep into the inference pipeline as feasible

### Current State

- Supabase stores messages and assets in plaintext (protected by RLS, but not encrypted at the application layer)
- Authentication exists (JWT-based via Supabase Auth) but no hardware key integration
- No client-side encryption pipeline
- vLLM receives plaintext context
- ✅ **Supabase migration `20260625100000_add_hardware_key_encryption` applied** — schema is live on local dev server

### Schema Inventory (Applied 2026-02-23)

**4 new tables (all RLS-enabled):**

| Table | Purpose | RLS |
|-------|---------|-----|
| `hardware_keys` | WebAuthn/FIDO2 credential registrations (public_key, counter, AAGUID, transports) | Users CRUD own; org admins read |
| `asset_key_policies` | Declares which assets require HW key touch per action | Asset admin manages; asset reader views |
| `key_assertions` | Ephemeral proof-of-presence (5-min TTL, single-use) | User read/delete own; **no INSERT policy** (Edge Function only) |
| `encrypted_asset_data` | Client-side encrypted payloads with key derivation metadata | read/write/admin via `has_resource_permission()` |

**4 support functions:**
- `has_key_protected_access(asset_type, asset_id, action, permission)` — Core: base perm → policy lookup → assertion check
- `has_multi_key_access(asset_type, asset_id, action)` — Counts distinct user assertions vs threshold
- `cleanup_expired_key_assertions()` — GC for expired assertions (no cron yet)
- `cleanup_asset_key_policies_for_resource()` — Trigger cascade on resource delete

**Key indexes:**
- `hardware_keys`: Partial `(user_id, is_active) WHERE is_active = true`, unique `credential_id`
- `asset_key_policies`: Unique `(asset_type, asset_id, protected_action)`
- `key_assertions`: Partial indexes on unconsumed assertions by user+asset and by expiry
- `encrypted_asset_data`: GIN on `authorized_key_ids` array

**CHECK constraints:**
- `key_assertions`: asset_type and asset_id must both be NULL or both non-NULL
- `encrypted_asset_data`: `authorized_key_ids` must have ≥1 entry
- All enum columns use CHECK constraints matching `resource_permissions.resource_type`

**Existing infrastructure leveraged:**
- `has_resource_permission()` — Polymorphic permission check (user/team/org grants)
- `permission_level()` — read=1, write=2, admin=3
- `pgcrypto` (installed), `supabase_vault` (installed)
- `pgsodium` (available, not yet installed), `pg_cron` (available, not yet installed)

**Data state (local dev):**
- 1 user, 2 orgs, 2 org_members, 5 agents, 2 chat_sessions, 2 repos
- 0 hardware_keys, 0 asset_key_policies, 0 key_assertions, 0 encrypted_asset_data

## Constraints & Requirements

### Hard Requirements

- **WebAuthn Level 3 PRF extension** required for key derivation from hardware keys (not just authentication)
- **No plaintext key material in logs, errors, or persistent storage** — ever
- **AES-256-GCM** minimum for symmetric encryption
- **Key material never leaves the server's memory unencrypted** after reconstruction
- **Supabase RLS still enforced** — encryption is defense-in-depth, not a replacement for access control
- **Graceful degradation** — system must work (with reduced security) when hardware keys are unavailable
- **Browser compatibility** — WebAuthn PRF extension support is required (Chrome 116+, Edge 116+; Firefox/Safari support is limited as of early 2026)

### Soft Requirements

- Support for multiple hardware keys per user (backup keys)
- Key escrow / recovery mechanism for lost hardware keys
- Performance budget: encryption/decryption overhead < 100ms for typical message payloads
- Streaming decryption for large assets
- Compatibility with existing message history format (migration path for unencrypted data)

### Out of Scope (For Now)

- Homomorphic encryption for vLLM inference (computationally impractical at LLM scale today)
- Custom hardware key firmware
- Post-quantum cryptographic algorithms (revisit when NIST PQC standards mature in libraries)
- Mobile native hardware key support (web-only initially)

## Honest Assessment of Complexity & Risks

**This is a large, complex goal.** Let me be upfront about the challenges:

### Complexity: HIGH

1. **WebAuthn PRF is bleeding-edge** — Browser support is incomplete. The `prf` extension (which allows deriving symmetric keys from a hardware authenticator's HMAC-secret) is part of WebAuthn Level 3. Chrome supports it, Firefox/Safari support is patchy. We're building on a spec that's still maturing.

2. **Multi-party decryption is non-trivial cryptography** — Combining key material from multiple hardware keys requires either Shamir's Secret Sharing (SSS) or a threshold cryptography scheme. Getting this right (without subtle vulnerabilities) requires careful protocol design.

3. **"OTP" terminology needs precision** — The user described "OTP passwords" derived from hardware keys. What this actually means in cryptographic terms: hardware keys produce **one-time derived key material** (via PRF/HMAC-secret challenge-response), which is then used to unwrap stored key shares. This is NOT a TOTP/HOTP code — it's ephemeral cryptographic material. The scratchpad will use the term **"key material"** or **"key share"** to be precise.

4. **vLLM encryption is the most ambitious piece** — True end-to-end encryption "all the way into vLLM" has four realistic interpretations:
   - **Option A: Encrypted transport + decryption at vLLM boundary** — Data is encrypted in transit and at rest, decrypted just before vLLM processes it. This is achievable today.
   - **Option B: NVIDIA Confidential Computing (CC) mode — Hardware VRAM Encryption** — The GPU hardware itself encrypts ALL data in VRAM using on-die AES. This is **real, shipping, and achievable on bare metal NixOS** with H100/Blackwell GPUs. See detailed research below.
   - **Option C: Full TEE (CPU + GPU)** — vLLM runs inside a CPU TEE (Intel TDX / AMD SEV-SNP) combined with GPU CC mode, providing full isolation from the host OS. Requires Kata containers + QEMU + CC attestation. More complex but fully documented by NVIDIA.
   - **Option D: Homomorphic encryption** — vLLM processes encrypted data directly. This is **not feasible** at LLM scale with current technology (orders of magnitude too slow).
   - **Recommendation: Start with Option A, add Option B (hardware VRAM encryption) as immediate next step since it's declaratively deployable on NixOS, evaluate Option C as future hardening.**

5. **Key management is a product in itself** — Registration, rotation, revocation, recovery, escrow, audit logging — each of these is substantial work.

### What Could Go Wrong

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| WebAuthn PRF not supported in user's browser | Feature unusable | Medium | Feature detection + graceful fallback to password-derived keys |
| Subtle crypto protocol vulnerability | Data exposure | Medium | Use well-audited libraries (Web Crypto API, @noble/ciphers), get protocol review |
| Lost hardware key = lost data | Permanent data loss | High | Key escrow, backup keys, recovery mechanism — design this FIRST |
| Performance degradation on large chat histories | Bad UX | Medium | Streaming decryption, pagination, caching decrypted sessions |
| vLLM integration breaks on encrypted payloads | Inference failures | Medium | Clear encryption boundary, integration tests |
| Multi-party key collection UX is confusing | User abandonment | High | Clear UI flow, progressive disclosure, good error messages |
| Supabase schema changes conflict with existing data | Migration failures | Low | Careful migration scripts, backward compatibility |

## Cryptographic Architecture

### Key Hierarchy

```
Hardware Key (FIDO2 Authenticator)
    │
    ├── PRF Extension (hmac-secret)
    │       │
    │       ▼
    │   Raw PRF Output (32 bytes)
    │       │
    │       ▼ HKDF-SHA256
    │   Key Encryption Key (KEK) — per user
    │       │
    │       ▼ AES-KW (Key Wrapping)
    │   Wrapped Data Encryption Key (DEK) share
    │
    ▼
Data Encryption Key (DEK) — per asset/conversation
    │
    ▼ AES-256-GCM
Encrypted Asset (ciphertext + IV + auth tag)
```

### Single-User Encryption Flow

1. **Registration**: User registers hardware key with `prf` extension → server stores credential ID + PRF salt
2. **Encrypt**: User authenticates with hardware key → PRF produces raw key material → HKDF derives KEK → generate random DEK → encrypt asset with DEK → wrap DEK with KEK → store {ciphertext, wrapped_DEK, salt, IV, credential_id}
3. **Decrypt**: User authenticates with hardware key → PRF reproduces raw key material → HKDF derives KEK → unwrap DEK → decrypt asset

### Multi-Party Encryption Flow (N-of-M Threshold)

1. **Setup**: Generate DEK → split DEK into M shares using Shamir's Secret Sharing (threshold = N)
2. **Distribute**: Each share is wrapped with the respective user's KEK (derived from their hardware key)
3. **Decrypt**: N users authenticate with their hardware keys → each unwraps their share → server combines N shares → reconstructs DEK → decrypts asset
4. **Transport**: Each user's unwrapped share is sent to the server inside a JWE (JSON Web Encryption) token, signed with the user's JWT for authentication

### Live Chat Real-Time Flow

1. **Session Key**: When a chat session starts, a session DEK is generated
2. **Key Distribution**: Session DEK is wrapped for each participant's KEK
3. **Message Encryption**: Each message is encrypted with the session DEK + unique IV
4. **Server-Side**: Server holds wrapped session DEK; when N participants have authenticated (contributed key material), server can decrypt for operations like:
   - Storing searchable metadata
   - Passing context to vLLM for inference
   - Generating summaries
5. **vLLM Handoff**: Decrypted context is passed to vLLM over encrypted channel (mTLS), processed, response encrypted with session DEK before storage

## Technology Choices (Preliminary)

### Client-Side
- **WebAuthn**: `@simplewebauthn/browser` + `@simplewebauthn/server` (most mature WebAuthn library)
- **Encryption**: Web Crypto API (native browser, no dependencies) for AES-256-GCM, HKDF
- **Shamir's Secret Sharing**: `@noble/curves` or `shamir` package (need to evaluate)
- **Fallback**: Password-based key derivation via PBKDF2/Argon2 when hardware keys unavailable

### Server-Side (Python Runtime)
- **WebAuthn Verification**: `py_webauthn` (well-maintained, Duo Security)
- **Encryption**: `cryptography` library (pyca/cryptography — industry standard)
- **Key Wrapping**: AES-KW via `cryptography` library
- **Shamir's SSS**: `Shamir` from `pycryptodome` or custom implementation
- **JWT/JWE**: `python-jose` or `authlib` for JWE token handling

### Server-Side (TypeScript Runtime)
- **WebAuthn Verification**: `@simplewebauthn/server`
- **Encryption**: Node.js `crypto` module (native)
- **JWE**: `jose` package (panva/jose — best JS JOSE implementation)

### Supabase
- Encrypted columns (bytea type for ciphertext)
- Key metadata tables (credential IDs, salts, share indices)
- RLS policies that also check key authorization
- Audit log table for all key operations

### vLLM Boundary
- mTLS for transport security to vLLM
- Decryption happens in the runtime server, just before constructing the vLLM request
- **Option B: NVIDIA CC mode** for hardware VRAM encryption (see detailed section below)
- Explore full CPU+GPU TEE (Option C) as future hardening

## NVIDIA Confidential Computing — Hardware VRAM Encryption (Research: 2026-02-23)

### The Short Answer

**YES — you can enable hardware-level VRAM encryption on a bare metal NixOS node.** The NVIDIA Hopper (H100) and Blackwell architectures have a hardware AES encryption engine built into the GPU die that encrypts ALL data in HBM (VRAM) and on the PCIe bus. The encryption keys are generated and managed entirely inside the GPU silicon — they never leave the chip and are never exposed to software, not even to the host OS kernel.

This means: vLLM runs exactly as normal (no code changes), but every byte of model weights, KV cache, activations, and user prompts in GPU memory is hardware-encrypted. An attacker with physical access (cold boot attack, PCIe bus snooping, even a compromised hypervisor) sees only ciphertext.

### What NVIDIA CC Mode Actually Does

1. **On-die AES-256 encryption** of all GPU HBM (High Bandwidth Memory / VRAM)
2. **PCIe bus encryption** — all data between CPU and GPU is encrypted in transit
3. **Hardware key management** — keys generated by GPU hardware RNG, stored in on-chip secure storage, rotated on GPU reset
4. **Remote attestation** — cryptographic proof that the GPU is genuine NVIDIA hardware running in CC mode with verified firmware (VBIOS RIM + driver RIM verification)
5. **~5-10% performance overhead** on H100 (surprisingly small for full memory encryption)

### Hardware Requirements

| Component | Requirement |
|-----------|-------------|
| **GPU** | NVIDIA H100 (Hopper) or newer (Blackwell B100/B200) |
| **CPU** | Intel with TDX support OR AMD with SEV-SNP (for full CPU+GPU TEE) |
| **BIOS** | IOMMU enabled, ACS (Access Control Services) enabled, hardware virtualization enabled |
| **Driver** | NVIDIA datacenter driver with CC support (≥535.86.05) |

**Important distinction**: For *just* GPU VRAM encryption (Option B), you primarily need the H100 + CC-capable driver. For the full CPU+GPU TEE (Option C), you additionally need Intel TDX or AMD SEV-SNP on the CPU side plus Kata containers.

### Three CC Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `off` | No confidential computing | Default, standard operation |
| `on` | Full CC mode — VRAM encrypted, attestation enforced | Production secure deployment |
| `devtools` | CC enabled but with debugging capabilities | Development and testing |

### NixOS Declarative Configuration (Bare Metal)

Based on NixOS options research, here's what a declarative CC-enabled bare metal config looks like. NixOS does **not** yet have a dedicated `hardware.nvidia.confidentialComputing` option, so some pieces require custom systemd services.

**Available NixOS options (already in nixpkgs):**

```nix
{
  # Core NVIDIA support
  hardware.nvidia.enabled = true;
  hardware.nvidia.package = config.boot.kernelPackages.nvidiaPackages.datacenter;  # DC drivers required
  hardware.nvidia.datacenter.enable = true;  # Enables fabricmanager for NVLink
  hardware.nvidia.gsp.enable = true;  # GPU System Processor — REQUIRED for CC mode
  hardware.nvidia.nvidiaPersistenced = true;  # Keep GPU alive in headless mode
  hardware.nvidia.open = true;  # Open kernel module (recommended for Hopper+)

  # Container toolkit with CDI
  hardware.nvidia-container-toolkit.enable = true;
  hardware.nvidia-container-toolkit.mount-nvidia-executables = true;

  # Kernel parameters for IOMMU (required for CC/passthrough)
  boot.kernelParams = [
    "intel_iommu=on"    # or "amd_iommu=on" for AMD
    "iommu=pt"          # passthrough mode for performance
  ];

  # VFIO kernel modules (needed if doing GPU passthrough to VM/container)
  boot.kernelModules = [
    "vfio"
    "vfio_iommu_type1"
    "vfio_pci"
  ];
}
```

**Custom systemd service needed (not yet in nixpkgs):**

```nix
{
  # Enable CC mode on boot — this is the piece NixOS doesn't have natively yet
  systemd.services.nvidia-cc-mode = {
    description = "Enable NVIDIA Confidential Computing Mode";
    after = [ "nvidia-persistenced.service" ];
    wants = [ "nvidia-persistenced.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${config.hardware.nvidia.package.bin}/bin/nvidia-smi conf-compute -scc on";
      # GPU reset is required after mode change
      ExecStartPost = "${config.hardware.nvidia.package.bin}/bin/nvidia-smi --gpu-reset";
    };
  };

  # Optional: Verify CC mode is active
  systemd.services.nvidia-cc-verify = {
    description = "Verify NVIDIA CC Mode Active";
    after = [ "nvidia-cc-mode.service" ];
    wants = [ "nvidia-cc-mode.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${config.hardware.nvidia.package.bin}/bin/nvidia-smi conf-compute -f";
      # Expected output: "CC status: ON"
    };
  };
}
```

### How This Fits Into Our Encryption Pipeline

The key insight is that **NVIDIA CC mode and our application-level encryption are complementary layers**, not alternatives:

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Application-Level Encryption (our Goal 40 pipeline)    │
│   Hardware Key → PRF → KEK → wrap DEK → AES-256-GCM            │
│   Protects: data at rest in Supabase, in transit via JWE,       │
│   user-controlled access via hardware keys + Shamir SSS         │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Transport Encryption (mTLS / TLS 1.3)                  │
│   Runtime server ←→ vLLM over encrypted channel                 │
│   Protects: data in transit between services                    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: NVIDIA CC Mode — Hardware VRAM Encryption (Option B)   │
│   On-die AES of all GPU HBM + PCIe bus encryption               │
│   Protects: data in use on the GPU — model weights, KV cache,   │
│   user prompts, activations — all encrypted in VRAM             │
│   Keys: hardware-managed, never exposed to software             │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4 (Future): Full CPU+GPU TEE (Option C)                   │
│   Intel TDX / AMD SEV-SNP + NVIDIA CC + Kata containers         │
│   Protects: everything — even a compromised host OS/hypervisor  │
│   cannot access plaintext data                                  │
└─────────────────────────────────────────────────────────────────┘
```

**The data flow with all layers active:**

1. User authenticates with hardware key → PRF derives key material
2. Server reconstructs DEK from key shares (Shamir SSS)
3. Server decrypts message history from Supabase (Layer 1 decryption)
4. Plaintext context sent to vLLM over mTLS (Layer 2)
5. vLLM loads context into GPU memory → **automatically hardware-encrypted in VRAM** (Layer 3)
6. GPU processes inference on encrypted memory — transparently
7. Response flows back through Layers 2 → 1 → encrypted storage

### What CC Mode Does NOT Do (Honest Limitations)

1. **Keys are not user-controlled** — The GPU generates its own encryption keys. You cannot inject your hardware-key-derived DEK into the GPU's encryption engine. This means CC mode is defense-in-depth, not a replacement for application-level encryption.

2. **Does not protect against a malicious vLLM process** — If the vLLM process itself is compromised, it can read its own GPU memory (it has to, to do inference). CC mode protects against external attackers, not the application itself.

3. **Requires GPU reset to change modes** — Switching between CC on/off requires a GPU reset, which kills all running CUDA processes. This is a boot-time configuration, not a runtime toggle.

4. **Single GPU passthrough only (in full TEE mode)** — In full CC + Kata mode, each VM gets exactly one GPU in passthrough. No multi-GPU sharing or vGPU. For bare metal Option B without Kata, this limitation doesn't apply.

5. **Attestation requires NVIDIA's attestation service** — Remote attestation (proving the GPU is in CC mode) phones home to NVIDIA. Local attestation is also supported but more limited.

### Full-Chain Vision (Hardware Key → Encrypted VRAM)

The user's ultimate vision — hardware keys controlling encryption all the way into GPU VRAM — has this realistic architecture:

1. **Hardware keys control ACCESS** (who can decrypt) — via our application-level crypto
2. **NVIDIA CC controls PROTECTION** (what happens to decrypted data) — via hardware VRAM encryption
3. **The bridge**: Once our server decrypts data using hardware-key-derived keys (Layer 1), that plaintext enters the GPU, where it's **immediately and transparently hardware-encrypted in VRAM** (Layer 3). At no point does plaintext data sit unprotected in memory — it's either encrypted by us or encrypted by the GPU hardware.

The only gap is during the brief moment between Layer 1 decryption (in CPU memory) and Layer 3 encryption (in GPU memory). This gap is closed by **Option C (full TEE)** — Intel TDX/AMD SEV-SNP encrypts CPU memory too, so plaintext never exists in unprotected memory anywhere in the pipeline.

## Approach

### Phase 1: Foundation (Tasks 01-03)
Cryptographic protocol research, Supabase schema, and DB-level maintenance (cron cleanup).

### Phase 2: Server Integration (Tasks 04-07)
Python hardware key service, encryption service, API routes, and TypeScript feature parity.

### Phase 3: Client-Side (Task 08) — Future
Client-side WebAuthn registration + PRF key derivation + encryption (lives in frontend repo).

### Phase 4: Multi-Party & Live Chat (Tasks 09-10) — Future
Shamir's Secret Sharing for N-of-M decryption, real-time live chat encryption.

### Phase 5: vLLM Bridge + NVIDIA CC (Task 11) — Future
Encrypted context pipeline to vLLM, secure decryption at inference boundary. NixOS declarative CC mode deployment for hardware VRAM encryption.

### Phase 6: Hardening (Tasks 12-13) — Future
Key rotation, revocation, recovery, audit logging, security review.

## Tasks

> **Branch**: `goal-40-hardware-key-encryption-server`
> **Working on**: Tasks 03-07 (Phase 1-2)

| Task ID | Directory | Description | Status | Depends On | Phase |
|---------|-----------|-------------|--------|------------|-------|
| Task-01 | `Task-01-Protocol-Design/` | Research & Cryptographic Protocol Design | 🟢 | — | 1 |
| Task-02 | `Task-02-Supabase-Schema/` | Supabase Data Model — Migration Applied | 🟢 | — | 1 |
| Task-03 | `Task-03-DB-Cron-Cleanup/` | pg_cron Assertion Cleanup Scheduling | 🟢 | Task-02 | 1 |
| Task-04 | `Task-04-Python-Key-Service/` | Python Hardware Key Service Module | 🟢 | Task-01, Task-02 | 2 |
| Task-05 | `Task-05-Python-Encryption-Service/` | Python Encryption Service Module | 🟢 | Task-04 | 2 |
| Task-06 | `Task-06-Python-Key-Routes/` | Python API Routes (`/keys/*`) | 🟢 | Task-04, Task-05 | 2 |
| Task-07 | `Task-07-TS-Key-Service/` | TypeScript Key Service & Routes | 🟢 | Task-06 | 2 |

### Session 27 Progress Summary (2026-02-23)

**Completed this session:**
- ✅ Committed Task-07: `5421ae0` — all 3 lefthook hooks pass
- ✅ Built local Docker image `fractal-agents-runtime-ts:local` (234 MB, Bun 1.3.9-slim)
- ✅ Added `bun-server` service to `docker-compose.yml` for local TS runtime testing
- ✅ **Integration tested against real Supabase Postgres** — found & fixed critical `Bun.sql` array bug
  - `Bun.sql` does NOT auto-serialize JS arrays → must use `sql.array()` for tagged templates
  - Fixed 4 locations: `transports`, `required_key_ids`, `authorized_key_ids` (×2)
  - For `sql.unsafe()`: added `toPostgresArrayLiteral()` helper (Postgres `{...}` format)
- ✅ 143 new tests: `auth.test.ts` (36), `db.test.ts` (16), `hardware-keys-models.test.ts` (91)
- ✅ **956 total tests, 0 fail, 77.64% line coverage** (threshold: 73%)
- ✅ Committed bugfix: `30a59bb` — NOT pushed yet

**Integration test results:**
- `GET /health` ✅ 200, `GET /info` ✅ 200 (`supabase_configured: true`)
- `GET /keys` (no auth) ✅ 401, `GET /keys` (with JWT) ✅ 200 `[]`
- `POST /keys/register` ⚠️ FK violation (test user not in `auth.users`) — **expected**, confirms array fix works

**Known issue:** Bun `mock.module()` pollutes process-wide module cache. Auth tests detect mock pollution and skip gracefully when run in full suite. Run `bun test tests/auth.test.ts` for full auth coverage (36/36 pass).

**What's next:**
1. Push branch + open PR + CI + merge
2. Full integration test with real Supabase user token (all 18 endpoints)
3. Release new version for webapp testing

### Session 26 Progress Summary (2026-02-25)

**Completed this session:**
- ✅ Task-07 (TS Key Service & Routes): Full implementation — 7 new files, 2 modified, 97 new tests
  - `apps/ts/src/lib/db.ts` — Bun.sql PostgreSQL wrapper (lazy singleton, localhost SSL auto-disable)
  - `apps/ts/src/lib/auth.ts` — JWT decode + optional HMAC-SHA256 verification via Web Crypto API
  - `apps/ts/src/models/hardware-keys.ts` — 13 interfaces, 11 error classes, 5 validation constant sets
  - `apps/ts/src/services/hardware-key-service.ts` — 15 service functions (key CRUD, assertions, policies, access checks)
  - `apps/ts/src/services/encryption-service.ts` — 7 service functions (encrypted asset CRUD, key-gated retrieval)
  - `apps/ts/src/routes/hardware-keys.ts` — 18 route handlers with auth, body parsing, error→status mapping
  - `apps/ts/tests/hardware-keys.test.ts` — 97 tests (all pass)
  - Modified: `config.ts` (+4 env vars), `index.ts` (+route registration)
- ✅ Zero npm packages added — Bun native only (Bun.sql, crypto.subtle, bun:test)
- ✅ 813 total tests pass across 14 files, `tsc --noEmit` clean
- ✅ **Phase 2 (Server Integration) is now COMPLETE** — all 4 tasks (04-07) done

**What's next:**
- Task-08: Client-Side WebAuthn + Encryption (Frontend) — Phase 3
- Or: manual integration testing of TS runtime against local Supabase dev server

### Session 22 Progress Summary (2026-02-23)

**Completed this session:**
- ✅ Task-01: Protocol design documented in `Task-01-Protocol-Design/scratchpad.md` (key hierarchy, 5 flows, library selections, threat model)
- ✅ Task-03 (DB Cron): `pg_cron` enabled, `cleanup-expired-key-assertions` scheduled every 5 min
- ✅ Task-04 (Python Key Service): `hardware_key_service.py` — 1331 lines, 15 functions (register, list, get, update, deactivate keys; record/get/consume/list assertions; create/list/get/delete policies; check_key_protected_access)
- ✅ Task-05 (Python Encryption Service): `encryption_service.py` — ~916 lines, 7 functions (store, get, get_with_key_check, list, delete encrypted assets; update_authorized_keys; consume_matching_assertions)
- ✅ `hardware_key_models.py` — Route-layer Pydantic models (may be superseded by service-layer models when routes are built)
- ✅ All 1055 existing tests pass, ruff clean

**Uncommitted files (on branch `goal-40-hardware-key-encryption-server`):**
- `apps/python/src/server/hardware_key_service.py` — Core key management service
- `apps/python/src/server/encryption_service.py` — Encrypted asset gatekeeper service
- `apps/python/src/server/hardware_key_models.py` — Route-layer Pydantic models
- `.agent/goals/40-Hardware-Key-Encryption-Pipeline/Task-01-Protocol-Design/scratchpad.md`
- `.agent/goals/40-Hardware-Key-Encryption-Pipeline/Task-03-Server-Side-Key-Services/scratchpad.md`
- Updated Goal 40 scratchpad

**Key architectural decisions documented:**
1. Server never sees plaintext — stores ciphertext, checks assertions, enforces policies
2. Edge Function for assertion INSERT (no INSERT RLS on key_assertions by design)
3. Interim: `py_webauthn` in runtime until Edge Function exists
4. Per-request connections following existing `database.py` pattern
5. KEK→DEK two-layer key hierarchy enables rotation + multi-party without re-encryption
6. PRF salt = `{action}:{asset_type}:{asset_id}` for domain separation

**What's next (Task-06):**
- Build Python API routes in `routes/hardware_keys.py` wiring to the services
- Register routes in `routes/__init__.py` and `app.py`
- Write integration tests against local Supabase dev server
- Then Task-07: TypeScript equivalent in `apps/ts/`
| Task-08 | — | Client-Side WebAuthn + Encryption (Frontend) | ⚪ | Task-06 | 3 |
| Task-09 | — | Multi-Party Threshold Decryption (Shamir's SSS) | ⚪ | Task-05 | 4 |
| Task-10 | — | Live Chat Real-Time Encryption/Decryption | ⚪ | Task-05, Task-09 | 4 |
| Task-11 | — | vLLM Encrypted Context Bridge + NVIDIA CC Mode | ⚪ | Task-05 | 5 |
| Task-12 | — | Key Lifecycle — Rotation, Revocation, Recovery & Audit | ⚪ | Task-09 | 6 |
| Task-13 | — | Security Review & Penetration Testing | ⚪ | All above | 6 |

### Task Descriptions

**Task-01: Research & Cryptographic Protocol Design** 🟢 COMPLETE (2026-02-23)
- Key hierarchy documented: PRF → HKDF → KEK → wraps DEK → AES-256-GCM payload
- Threat model (server compromise, replay, clone detection, memory dump) documented
- Technology choices: WebAuthn PRF + Web Crypto (client), py_webauthn (Edge Fn), psycopg (runtime)
- Full details in `Task-01-Protocol-Research/scratchpad.md`
- **Deliverable**: ✅ Protocol design, key hierarchy, threat model, library recommendations

**Task-02: Supabase Data Model — Encrypted Assets & Key Registry** 🟢 COMPLETE (2026-02-23)
- Migration `20260625100000_add_hardware_key_encryption` applied to local dev server
- Tables created: `hardware_keys`, `asset_key_policies`, `key_assertions`, `encrypted_asset_data`
- RLS policies active on all 4 tables; `key_assertions` INSERT intentionally restricted to Edge Function
- Support functions: `has_key_protected_access()`, `has_multi_key_access()`, `cleanup_expired_key_assertions()`
- Triggers: `updated_at` auto-update on hardware_keys, asset_key_policies, encrypted_asset_data
- All CHECK constraints and indexes verified
- Full details in `Task-02-Supabase-Schema/scratchpad.md`
- **Deliverable**: ✅ SQL migrations, RLS policies, support functions — all live

**Task-03: pg_cron Assertion Cleanup Scheduling** ⚪ NOT STARTED
- Enable `pg_cron` extension and schedule `cleanup_expired_key_assertions()` every 5 min
- Fallback: application-level cleanup if pg_cron unavailable
- Full details in `Task-03-DB-Cron-Cleanup/scratchpad.md`
- **Deliverable**: Cron job or application-level cleanup running

**Task-04: Python Hardware Key Service Module** ⚪ NOT STARTED
- Service layer: register/list/deactivate keys, verify assertions, consume assertions, check access
- Pydantic models for all request/response types
- Per-request DB connections following `database.py` pattern
- Full details in `Task-04-Python-Key-Service/scratchpad.md`
- **Deliverable**: `apps/python/src/server/hardware_key_service.py`

**Task-05: Python Encryption Service Module** ⚪ NOT STARTED
- Service layer: store/retrieve/delete encrypted payloads, key-assertion-gated retrieval
- Base64 encoding at API boundary for binary data (bytea ↔ base64 string)
- Assertion consumption transactional with data retrieval
- Custom exceptions: `KeyAssertionRequired`, `InsufficientKeyAssertions`, `InvalidAuthorizedKeys`
- Full details in `Task-05-Python-Encryption-Service/scratchpad.md`
- **Deliverable**: `apps/python/src/server/encryption_service.py`

**Task-06: Python API Routes (`/keys/*`)** ⚪ NOT STARTED
- 15 Robyn HTTP endpoints under `/keys/` prefix
- Key CRUD, assertion management, policy management, encrypted data CRUD
- HTTP 428 Precondition Required for key-assertion-required scenarios
- Full details in `Task-06-Python-Key-Routes/scratchpad.md`
- **Deliverable**: `apps/python/src/server/routes/hardware_keys.py`

**Task-07: TypeScript Key Service & Routes** ⚪ NOT STARTED
- Port Python implementation to Bun/Hono TypeScript runtime
- Same API contract (paths, status codes, error format)
- TypeScript types for compile-time safety
- Full details in `Task-07-TS-Key-Service/scratchpad.md`
- **Deliverable**: `apps/ts/src/services/hardware-key-service.ts`, `apps/ts/src/routes/hardware-keys.ts`

**Task-08: Client-Side WebAuthn + Encryption** ⚪ NOT STARTED (Future — Frontend Repo)
- WebAuthn registration flow with `prf` extension
- Key derivation pipeline (PRF → HKDF → KEK)
- Asset encryption/decryption using Web Crypto API
- Browser feature detection and graceful fallback
- **Deliverable**: Client-side encryption library/module, registration UI flow

**Task-09: Multi-Party Threshold Decryption (Shamir's SSS)** ⚪ NOT STARTED (Future)
- Shamir's Secret Sharing implementation (or well-audited library)
- Share generation, distribution, and reconstruction
- Threshold configuration per asset/conversation (e.g., 2-of-3, 3-of-5)
- Share refresh (re-sharing without changing secret)
- **Deliverable**: SSS module, multi-party decryption flow

**Task-10: Live Chat Real-Time Encryption/Decryption** ⚪ NOT STARTED (Future)
- Session key generation and distribution on chat start
- Real-time message encryption/decryption
- Participant join/leave key management
- Integration with existing SSE/streaming infrastructure
- **Deliverable**: Encrypted live chat prototype

**Task-11: vLLM Encrypted Context Bridge + NVIDIA CC Mode** ⚪ NOT STARTED (Future)
- Secure channel (mTLS) between runtime and vLLM
- Decryption at inference boundary
- Encrypted response handling and re-encryption for storage
- **NixOS declarative NVIDIA CC mode configuration** for bare metal H100 node:
  - Datacenter driver + GSP + IOMMU + VFIO kernel modules
  - Custom systemd service for `nvidia-smi conf-compute -scc on`
  - CC mode verification and attestation
  - nvidia-container-toolkit CDI for containerized vLLM access to CC-mode GPU
- Performance benchmarking (CC mode ~5-10% overhead + application encryption overhead)
- Document the 4-layer encryption architecture (app → transport → VRAM → full TEE)
- **Deliverable**: vLLM encryption bridge, NixOS CC module, benchmarks

**Task-12: Key Lifecycle — Rotation, Revocation, Recovery & Audit** ⚪ NOT STARTED (Future)
- Key rotation (re-encrypt assets with new DEK without re-wrapping all KEKs)
- Key revocation (remove a user's access, re-share remaining shares)
- Key recovery (backup key registration, social recovery, optional escrow)
- Comprehensive audit logging (who decrypted what, when, from where)
- **Deliverable**: Key lifecycle management, audit log queries

**Task-13: Security Review & Penetration Testing** ⚪ NOT STARTED (Future)
- Protocol review against known attacks
- Timing attack analysis on crypto operations
- Key material exposure analysis (memory dumps, logs, errors)
- Penetration testing of key transport endpoints
- **Deliverable**: Security report, fixes for findings

## Dependencies

### Upstream (Things This Goal Depends On)

- **Supabase data model update** — User is applying migrations; Task-02 blocked until ready
- **Goal 33 (Auth Best Practices)** — 🟢 Complete; JWT infrastructure we'll build on
- **Goal 37 (v0.1.0)** — 🟢 Complete; stable runtime foundation
- **WebAuthn PRF browser support** — External dependency on browser vendors

### Downstream (Things That Depend on This Goal)

- Any future compliance features (SOC 2, HIPAA) will benefit from this encryption layer
- End-to-end encrypted agent conversations
- Encrypted RAG document storage
- Zero-knowledge proof of asset access (potential future goal)

## Notes & Decisions

### Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-23 | Goal created, blocked on Supabase schema | User is applying data model changes; no point designing tables until schema is finalized |
| 2026-02-23 | AES-256-GCM chosen over AES-256-CBC | GCM provides authenticated encryption (integrity + confidentiality), CBC requires separate HMAC |
| 2026-02-23 | WebAuthn PRF over TOTP-based approach | PRF provides actual cryptographic key material; TOTP only provides 6-8 digit codes unsuitable for key derivation |
| 2026-02-23 | Shamir's SSS chosen for multi-party over threshold RSA | SSS is simpler, well-understood, information-theoretically secure; threshold RSA is overkill here |
| 2026-02-23 | vLLM encryption starts with Option A (boundary decryption) | Homomorphic encryption is impractical; TEE is future work |
| 2026-02-23 | NVIDIA CC mode (Option B) promoted to near-term target | Research confirmed H100 hardware VRAM encryption is real, shipping, and declaratively deployable on NixOS. ~5-10% perf overhead. Does not require code changes to vLLM. |
| 2026-02-23 | NixOS CC config requires custom systemd service | No `hardware.nvidia.confidentialComputing` option in nixpkgs yet. Need custom service for `nvidia-smi conf-compute -scc on` + GPU reset at boot. |
| 2026-02-23 | 4-layer encryption architecture defined | App-level (hardware keys) → Transport (mTLS) → VRAM (NVIDIA CC) → Full TEE (future). Each layer is independent and additive. |

### Open Questions

- [ ] What is the exact Supabase schema for encrypted assets? (Waiting on user's migration)
- [ ] What threshold configurations are needed? (e.g., always 2-of-3? or configurable per conversation?)
- [ ] Is there a specific hardware key model to target? (YubiKey 5 series supports PRF, older keys may not)
- [ ] What is the fallback UX when a user doesn't have a hardware key? (Password-derived keys? No encryption?)
- [ ] Should encrypted assets be searchable? (Requires searchable encryption or encrypted indexes — significant complexity)
- [x] ~~Is the vLLM deployment on hardware that supports TEE (SGX/TDX/SEV)?~~ **ANSWERED**: User confirmed bare metal node with H100-class GPU. NVIDIA CC mode is available for hardware VRAM encryption. CPU TEE (TDX/SEV-SNP) status TBD — need to confirm CPU model.
- [ ] What is the key recovery policy? (Escrow with org admin? Social recovery? Accept data loss on key loss?)
- [ ] How does this interact with Supabase Realtime for live chat? (Encrypted payloads through Realtime channels?)
- [ ] What is the expected number of participants in multi-party decryption? (2-3 vs 10+? affects protocol choice)
- [ ] What is the exact GPU model on the bare metal node? (H100 PCIe vs SXM? Affects NVLink/fabricmanager config)
- [ ] What CPU is in the bare metal node? (Intel with TDX? AMD with SEV-SNP? Determines if full TEE Option C is possible)
- [ ] Is the node already running NixOS or being set up fresh? (Affects migration strategy for CC mode)
- [ ] Should we contribute a `hardware.nvidia.confidentialComputing` NixOS module upstream? (Not in nixpkgs yet)

### Terminology Clarification

The user described "OTP passwords" generated from hardware keys. For precision in this goal:

- **"OTP" in this context** → **One-time key material** derived from the hardware key's PRF/HMAC-secret extension. This is NOT a TOTP (Time-based One-Time Password) code. It's 32 bytes of pseudorandom key material that is unique per challenge.
- **"Hardware key"** → FIDO2-compatible authenticator with `hmac-secret`/PRF extension support (e.g., YubiKey 5 series, newer models)
- **"Asset"** → Any user data that should be encrypted: chat messages, documents, conversation history, uploaded files
- **"Key share"** → A piece of a split encryption key (via Shamir's Secret Sharing) that one user holds

## References

### WebAuthn & Client-Side Crypto
- [WebAuthn Level 3 Spec — PRF Extension](https://www.w3.org/TR/webauthn-3/#prf-extension)
- [FIDO2 CTAP2 hmac-secret Extension](https://fidoalliance.org/specs/fido-v2.1-rd-20210309/fido-client-to-authenticator-protocol-v2.1-rd-20210309.html#sctn-hmac-secret-extension)
- [SimpleWebAuthn Library](https://simplewebauthn.dev/)
- [Web Crypto API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)

### Cryptographic Standards
- [Shamir's Secret Sharing — Wikipedia](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing)
- [AES-256-GCM — NIST SP 800-38D](https://csrc.nist.gov/publications/detail/sp/800-38d/final)
- [HKDF — RFC 5869](https://datatracker.ietf.org/doc/html/rfc5869)
- [JWE — RFC 7516](https://datatracker.ietf.org/doc/html/rfc7516)

### Libraries
- [pyca/cryptography Library](https://cryptography.io/)
- [py_webauthn Library](https://github.com/duo-labs/py_webauthn)
- [panva/jose — JS JOSE Implementation](https://github.com/panva/jose)

### NVIDIA Confidential Computing
- [NVIDIA Trusted Computing Solutions — Docs Hub](https://docs.nvidia.com/confidential-computing/)
- [GPU Operator with Confidential Containers — Deployment Guide](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-operator-confidential-containers.html)
- [NVIDIA Hopper CC Attestation Documentation](https://docs.nvidia.com/confidential-computing/) → Attestation section
- [NVIDIA Secure AI Compatibility Matrix](https://docs.nvidia.com/confidential-computing/) → Compatibility Matrix
- [nvtrust GitHub — Attestation SDK & Verifier](https://github.com/NVIDIA/nvtrust)
- [NVIDIA H100 Architecture Whitepaper — CC section](https://resources.nvidia.com/en-us-tensor-core)
- GTC Talk: "Hopper Confidential Computing: How it Works under the Hood"
- GTC Talk: "Confidential Computing: The Developer's View to Secure an Application and Data on NVIDIA H100"

### NixOS GPU Configuration
- NixOS option: `hardware.nvidia.datacenter.enable` — Data Center drivers for NVLink topology
- NixOS option: `hardware.nvidia.gsp.enable` — GPU System Processor (required for CC)
- NixOS option: `hardware.nvidia-container-toolkit.enable` — CDI configuration
- NixOS option: `boot.kernelParams` — for `intel_iommu=on` / `iommu=pt`
- NixOS option: `boot.kernelModules` — for `vfio`, `vfio_iommu_type1`, `vfio_pci`
- **Note**: No `hardware.nvidia.confidentialComputing` option exists in nixpkgs yet — custom systemd service required

### CPU TEE (Future Option C)
- [Intel TDX Documentation](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html)
- [AMD SEV-SNP Documentation](https://www.amd.com/en/developer/sev.html)
- [Confidential Containers Operator](https://github.com/confidential-containers/operator)