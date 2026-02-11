# Goal 04 — Supabase Development Stack Integration

Status: 🟡 In Progress  
Priority: High  
Owner: You  
Last Updated: 2026-01-27

## Objective

Integrate the LangGraph tools agent with the local Supabase development stack, enabling seamless local development, testing, and debugging with a fully functional Supabase environment. This includes:

1. **Environment configuration** for local Supabase dev stack
2. **Authentication setup** using local Supabase JWT tokens
3. **RAG tool integration** with local Supabase database
4. **MCP server connectivity** to local Supabase MCP endpoint
5. **Documentation** for local development workflow

## Context

The user has a running Supabase dev stack with the following services:
- **Studio**: http://127.0.0.1:54323
- **MCP**: http://127.0.0.1:54321/mcp
- **Project URL**: http://127.0.0.1:54321
- **Database**: postgresql://postgres:postgres@127.0.0.1:54322/postgres
- **Auth Keys**:
  - Publishable: `<REDACTED - use local supabase publishable key>`
  - Secret: `<REDACTED - use local supabase secret key>`

The agent already has Supabase integration capabilities but needs to be configured for local development.

## Success Criteria (Acceptance Checklist)

- [x] Environment variables are properly configured for local development
- [x] Documentation exists for setting up local Supabase dev environment
- [ ] Agent can authenticate using local Supabase JWT tokens
- [ ] RAG tools work with local Supabase database
- [ ] MCP tools can connect to local Supabase MCP server
- [ ] Development workflow is streamlined (one-command setup if possible)
- [ ] Tests pass with local Supabase configuration
- [ ] No breaking changes to production configuration

## Research Needed

1. **Current Supabase integration**: Review existing code in `agent.py`, `utils/token.py`, `utils/tools.py`
2. **Environment configuration**: Check `.env.example` (if accessible) and current environment variable usage
3. **Authentication flow**: Understand how JWT tokens are exchanged and validated
4. **RAG tool dependencies**: Check what Supabase tables/schemas are required
5. **MCP server requirements**: Verify MCP server compatibility and authentication

## Implementation Plan

### Phase 1: Environment Configuration
1. Create local development environment configuration
2. Set up environment variables for local Supabase stack
3. Ensure fallback to production configuration when needed

### Phase 2: Authentication Integration
1. Test JWT token validation with local Supabase
2. Verify token exchange flow for MCP access
3. Ensure proper error handling for authentication failures

### Phase 3: RAG Tool Integration
1. Configure RAG tools to use local Supabase database
2. Test document search functionality
3. Verify collection creation and management

### Phase 4: MCP Server Connectivity
1. Test connection to local Supabase MCP server
2. Verify tool discovery and execution
3. Ensure proper authentication flow

### Phase 5: Documentation & Testing
1. Create local development guide
2. Add tests for local Supabase integration
3. Update README with local setup instructions

## Proposed Task Breakdown

### Task 01 — Environment Configuration & Setup ✅ COMPLETE
- ✅ Create local development configuration files
- ✅ Set up environment variables for local Supabase
- ✅ Test basic connectivity to local Supabase services
- ✅ Create comprehensive local setup guide

### Task 02 — Authentication Integration Testing ⚪ Not Started
- Test JWT token validation with local Supabase
- Verify MCP token exchange flow
- Implement proper error handling

### Task 03 — RAG Tool Local Integration ⚪ Not Started
- Configure RAG tools for local database
- Test document search functionality
- Verify collection management

### Task 04 — MCP Server Local Connectivity ⚪ Not Started
- Test connection to local Supabase MCP server
- Verify tool discovery and execution
- Ensure authentication flow works

### Task 05 — Documentation & Workflow Optimization ⚪ Not Started
- Create local development guide
- Streamline setup process
- Update README and add examples

## Files Likely To Change

- Environment configuration files (`.env.local`, `.env.development`)
- `README.md` (documentation updates)
- `pyproject.toml` (if additional dev dependencies needed)
- `tools_agent/utils/token.py` (potential auth flow adjustments)
- `tools_agent/utils/tools.py` (RAG tool configuration)
- `tools_agent/agent.py` (MCP server URL configuration)

## Risks & Mitigations

1. **Risk**: Local configuration conflicts with production
   **Mitigation**: Use separate environment files and clear naming conventions

2. **Risk**: Breaking existing Supabase integration
   **Mitigation**: Maintain backward compatibility, test thoroughly

3. **Risk**: Local Supabase stack differences from production
   **Mitigation**: Document differences clearly, provide migration guidance

4. **Risk**: Authentication flow differences
   **Mitigation**: Test both local and production auth flows

## Dependencies

- Goal 02 (LangSmith removal) should be complete or near-complete
- Local Supabase dev stack must be running and accessible
- No conflicts with Langfuse integration (Goal 03)

## Notes

- The agent already has Supabase dependencies (`supabase>=2.15.1`)
- Authentication middleware is already implemented
- RAG tools already support Supabase authentication
- MCP token exchange already uses Supabase tokens

## Next Steps

1. ✅ Update goals index to include this goal
2. ✅ Complete Task 01 research and implementation
3. ✅ Test basic connectivity to local Supabase services
4. Begin Task 02 — Authentication Integration Testing
5. Iterate through remaining tasks

## References

- [Supabase Local Development](https://supabase.com/docs/guides/local-development)
- [Supabase JavaScript/TypeScript Client](https://supabase.com/docs/reference/javascript/introduction)
- [LangGraph Custom Authentication](https://langchain-ai.github.io/langgraph/tutorials/auth/getting_started/)
- [MCP (Model Context Protocol)](https://spec.modelcontextprotocol.io/)