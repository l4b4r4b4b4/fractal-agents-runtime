# Task-02: Supabase Data Model — Encrypted Assets & Key Registry

> **Status**: 🟢 Complete
> **Phase**: 1 — Foundation
> **Updated**: 2026-02-23

## Objective

Design and apply the Supabase schema for hardware key encryption: tables for key registrations, key policies, ephemeral assertions, and encrypted asset storage.

## What Was Done

Migration `20260625100000_add_hardware_key_encryption` applied to local Supabase dev server.

### Tables Created

#### `hardware_keys`
- WebAuthn/FIDO2 credential registrations
- Columns: `id`, `user_id` (→ auth.users), `credential_id` (unique, base64url), `public_key` (bytea, COSE), `counter` (bigint), `transports` (text[]), `friendly_name`, `device_type` (enum), `attestation_format`, `aaguid`, `is_active`, `last_used_at`, `created_at`, `updated_at`
- RLS: Users CRUD own keys; org admins can read member keys
- Indexes: Partial `(user_id, is_active) WHERE is_active = true`, unique `credential_id`

#### `asset_key_policies`
- Declares which assets require hardware key touch for which operations
- Columns: `id`, `asset_type` (enum), `asset_id` (uuid, polymorphic), `protected_action` (decrypt/delete/export/share/sign/all_writes/admin), `required_key_count` (≥1), `required_key_ids` (uuid[], optional), `created_by_user_id`, `created_at`, `updated_at`
- UNIQUE constraint on `(asset_type, asset_id, protected_action)`
- RLS: Only asset admin can manage; asset reader can view

#### `key_assertions`
- Ephemeral proof-of-presence records (5-min TTL, single-use)
- Columns: `id`, `user_id` (→ auth.users), `hardware_key_id` (→ hardware_keys), `asset_type` (nullable), `asset_id` (nullable), `challenge` (text), `verified_at`, `expires_at` (default now()+5min), `consumed` (bool), `consumed_at`
- CHECK: `asset_type` and `asset_id` must both be NULL or both non-NULL
- **No INSERT RLS policy** — by design, only Edge Function (SECURITY DEFINER) can insert
- Indexes: Partial on unconsumed assertions by user+asset and by expiry

#### `encrypted_asset_data`
- Client-side encrypted payloads with key derivation metadata
- Columns: `id`, `asset_type` (enum), `asset_id` (uuid), `encrypted_payload` (bytea), `encryption_algorithm` (AES-GCM-256/AES-CBC-256/ChaCha20-Poly1305), `key_derivation_method` (webauthn-prf-hkdf/webauthn-hmac-secret-hkdf/passphrase-pbkdf2/shamir-recombine), `initialization_vector` (bytea), `authorized_key_ids` (uuid[], ≥1), `encrypted_by_user_id`, `created_at`, `updated_at`
- RLS: read via `has_resource_permission('read')`, write via `has_resource_permission('write')`, delete via `has_resource_permission('admin')`
- GIN index on `authorized_key_ids` for "which keys can decrypt this?" queries

### Functions Created

1. **`has_key_protected_access(asset_type, asset_id, action, permission)`**
   - Core authorization function
   - Step 1: Check base `has_resource_permission()`
   - Step 2: Look up `asset_key_policies` for this asset + action
   - Step 3: No policy → base permission is sufficient
   - Step 4: Multi-key → delegate to `has_multi_key_access()`
   - Step 5: Single-key → check for valid, unconsumed assertion from current user

2. **`has_multi_key_access(asset_type, asset_id, action)`**
   - Counts distinct users with valid assertions
   - Compares against `required_key_count` threshold

3. **`cleanup_expired_key_assertions()`**
   - Deletes assertions where `expires_at < now()`
   - Returns count of deleted rows
   - **No cron job configured yet** (→ Task-03)

4. **`cleanup_asset_key_policies_for_resource()`**
   - Trigger function for cascade-deleting policies when parent resource is deleted

### Triggers Created

- `set_hardware_keys_updated_at` → `handle_updated_at()` on UPDATE
- `set_asset_key_policies_updated_at` → `handle_updated_at()` on UPDATE
- `set_encrypted_asset_data_updated_at` → `handle_updated_at()` on UPDATE

### Foreign Key Relationships

- `hardware_keys.user_id` → `auth.users.id`
- `key_assertions.user_id` → `auth.users.id`
- `key_assertions.hardware_key_id` → `hardware_keys.id`
- `asset_key_policies.created_by_user_id` → `auth.users.id`
- `encrypted_asset_data.encrypted_by_user_id` → `auth.users.id`

### Extensions Status

| Extension | Status | Purpose |
|-----------|--------|---------|
| `pgcrypto` | ✅ Installed | `gen_random_bytes()`, `gen_random_uuid()` |
| `supabase_vault` | ✅ Installed | Server-side secret storage |
| `pgsodium` | Available (not installed) | libsodium crypto if needed server-side |
| `pg_cron` | Available (not installed) | Assertion cleanup scheduling (→ Task-03) |

## Verification

- All 4 tables have RLS enabled: ✅
- All CHECK constraints verified: ✅
- All indexes verified: ✅
- All FK relationships verified: ✅
- No new security advisor warnings: ✅
- 0 rows in all 4 tables (clean slate): ✅

## Remaining Follow-ups (Not Blockers)

- [ ] Enable `pg_cron` + schedule assertion cleanup (→ Task-03)
- [ ] Consider `pgsodium` for server-side crypto operations
- [ ] Resource cleanup triggers for all asset types that reference `asset_key_policies` and `encrypted_asset_data`

## Deliverables

- [x] SQL migration applied and verified
- [x] RLS policies active on all tables
- [x] Support functions created and verified
- [x] Triggers for `updated_at` maintenance
- [x] Schema documented in this scratchpad