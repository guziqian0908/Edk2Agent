---
description: Check EDK2 Agent login status and API configuration
agent: general
---

# Status Command

Please display the following information:

1. Login status:
   - Logged in: Yes/No
   - Username: (if logged in)
   - Session expires: (if logged in)

2. API Configuration:
   - Active provider: (anthropic/openai/etc)
   - Using: (user-configured / built-in fallback)

3. Available Skills:
   - edk2-pr-workflow: (enabled/disabled based on login)
   - ovmf-build: (enabled/disabled based on login)

4. MCP Services:
   - edk2-rag: (enabled/disabled based on login)