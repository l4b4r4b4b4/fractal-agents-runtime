# Task 02 — Authentication Integration Testing

Status: ⚪ Not Started  
Parent Goal: [04-Supabase-Integration](../scratchpad.md)  
Priority: High  
Owner: You  
Last Updated: 2026-01-27

## Objective

Test and verify the authentication integration between the LangGraph tools agent and the local Supabase development stack. This includes JWT token validation, MCP token exchange flow, and proper error handling for local development scenarios.

## Context

Task 01 completed the environment configuration analysis and created a comprehensive local setup guide. Now we need to test the actual authentication flow with the local Supabase stack:

- **Local Supabase URL**: http://127.0.0.1:54321
- **Local Supabase Secret Key**: `<REDACTED - use local supabase secret>`
- **Local MCP Server**: http://127.0.0.1:54321/mcp
- **Authentication Flow**: JWT tokens from local Supabase → validation → MCP token exchange

## Success Criteria

- [ ] JWT tokens from local Supabase validate successfully
- [ ] Authentication middleware works with local configuration
- [ ] MCP token exchange flow functions with local Supabase
- [ ] Proper error handling for authentication failures
- [ ] Clear error messages for common local development issues
- [ ] Documentation of authentication testing process

## Implementation Plan

### Phase 1: JWT Token Validation Testing
1. Generate test JWT tokens from local Supabase
2. Test token validation in `auth.py` with local configuration
3. Verify user identity extraction and metadata injection
4. Test error cases (invalid tokens, expired tokens, missing headers)

### Phase 2: MCP Token Exchange Testing
1. Test `get_mcp_access_token()` function with local Supabase
2. Verify token exchange endpoint at `http://127.0.0.1:54321/oauth/token`
3. Test token storage and retrieval in `fetch_tokens()`
4. Verify token expiration handling

### Phase 3: End-to-End Authentication Flow
1. Test complete auth flow: JWT → validation → MCP token → tool access
2. Verify authentication middleware integration
3. Test thread/assistant ownership enforcement
4. Verify store authorization

### Phase 4: Error Handling & Diagnostics
1. Implement comprehensive error logging
2. Create user-friendly error messages for common issues
3. Add diagnostic tools for troubleshooting
4. Document common authentication problems and solutions

## Technical Approach

### JWT Token Testing Strategy
```python
# Test token validation
async def test_jwt_validation():
    # 1. Get test token from local Supabase
    # 2. Call auth.get_current_user() with token
    # 3. Verify user identity is returned
    # 4. Test invalid token scenarios
    pass
```

### MCP Token Exchange Testing
```python
# Test token exchange
async def test_mcp_token_exchange():
    # 1. Use valid Supabase JWT
    # 2. Call get_mcp_access_token() with local MCP URL
    # 3. Verify access token is returned
    # 4. Test error cases (invalid JWT, wrong URL, etc.)
    pass
```

### Integration Testing
```python
# Test complete auth flow
async def test_complete_auth_flow():
    # 1. Start agent with local Supabase config
    # 2. Authenticate with local JWT
    # 3. Access protected endpoints
    # 4. Verify ownership enforcement
    pass
```

## Files to Create/Modify

### Test Files:
- `tests/test_auth_local.py` - Local authentication tests
- `tests/test_mcp_token_exchange.py` - MCP token exchange tests
- `scripts/generate_test_tokens.py` - Helper to generate test tokens

### Documentation:
- `docs/auth-testing.md` - Authentication testing guide
- `docs/troubleshooting-auth.md` - Troubleshooting guide

### Potential Code Modifications:
- `tools_agent/security/auth.py` - Enhanced error handling/logging
- `tools_agent/utils/token.py` - Improved token exchange diagnostics
- `README.md` - Add authentication testing section

## Testing Scenarios

### Positive Test Cases:
1. ✅ Valid JWT token from local Supabase
2. ✅ Successful MCP token exchange
3. ✅ Thread creation with proper ownership
4. ✅ Assistant creation with proper ownership
5. ✅ Store access with proper authorization

### Negative Test Cases:
1. ❌ Missing Authorization header
2. ❌ Invalid JWT token format
3. ❌ Expired JWT token
4. ❌ Wrong Supabase URL configuration
5. ❌ Invalid Supabase secret key
6. ❌ MCP server unavailable
7. ❌ Token exchange failure

### Edge Cases:
1. ⚠️ Network timeouts to local Supabase
2. ⚠️ Local Supabase service restart during auth
3. ⚠️ Concurrent authentication requests
4. ⚠️ Very large JWT tokens
5. ⚠️ Unicode in user metadata

## Dependencies

- Task 01 completed (environment configuration)
- Local Supabase dev stack running
- Test JWT tokens from local Supabase
- Python test environment with pytest/asyncio

## Risks & Mitigations

### Risk 1: Test tokens interfering with production
**Mitigation**: Use dedicated test users in local Supabase, clear test data after tests

### Risk 2: Authentication tests affecting running services
**Mitigation**: Use test-specific ports, mock external services where appropriate

### Risk 3: Complex test setup
**Mitigation**: Create automated setup scripts, document step-by-step process

### Risk 4: Flaky tests due to network issues
**Mitigation**: Add retries, timeouts, and skip network-dependent tests in CI

## Next Steps

1. Set up test environment with local Supabase configuration
2. Create test token generation script
3. Implement basic JWT validation tests
4. Test MCP token exchange flow
5. Create integration tests for complete auth flow
6. Document testing process and results

## Notes

- Local Supabase uses the same authentication API as production
- JWT validation should work identically with proper configuration
- MCP token exchange may have local-specific endpoints
- Error messages should be helpful for local development debugging

## References

- [Supabase Auth API](https://supabase.com/docs/reference/javascript/auth)
- [JWT (JSON Web Tokens)](https://jwt.io/introduction)
- [OAuth 2.0 Token Exchange](https://datatracker.ietf.org/doc/html/rfc8693)
- [LangGraph Custom Auth Testing](https://langchain-ai.github.io/langgraph/tutorials/auth/testing/)