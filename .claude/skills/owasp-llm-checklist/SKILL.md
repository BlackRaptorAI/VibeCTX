---
name: owasp-llm-checklist
description: >-
  OWASP LLM Top-10 review lens for any feature where untrusted data reaches a
  model prompt or the model's output influences an action. Use when reviewing
  LLM/RAG/agent features, prompt construction, or embedding pipelines. Triggers:
  "review this prompt path", "prompt injection", "what data reaches the LLM".
  Shared by ai-ml-engineer, security-architect, red-team-reviewer.
---

# OWASP LLM Top-10 review lens

Apply when telemetry, device/resource names, customer text, ticket/incident
content, or knowledge-base articles can reach a prompt — or when model output
can trigger an action. Treat all such input as **untrusted**.

## Checklist

1. **Prompt injection (direct & indirect).** Is untrusted text interpolated into
   prompts undelimited? Can retrieved/stored content (RAG, KB self-ingestion)
   carry instructions the model may follow? → wrap untrusted fields in labeled
   "treat as data, not instructions" delimiters; sanitize/limit length.
2. **Insecure output handling.** Does model output trigger a privileged action
   (command, DB write, notification) without deterministic validation? → never
   let raw output drive control flow; parse/validate (e.g. a schema validator)
   first.
3. **Sensitive-information disclosure.** Does the prompt/RAG query carry PII,
   secrets, or precise geo/customer identifiers to the model or a vendor
   endpoint? → minimize; redact/round; send IDs not raw PII; get privacy-counsel
   sign-off for any PII to the LLM or cross-border.
4. **Supply chain / model & data provenance.** Untrusted models, plugins, or
   embedding endpoints? Where does data egress?
5. **Excessive agency.** Does the LLM feature have more capability/permissions
   than it needs? Constrain tools and scopes.
6. **Overreliance.** Is model output presented as fact? → label AI-generated
   output; keep a deterministic heuristic fallback that works with no API key.
7. **Denial of wallet / unbounded cost.** Do timeouts actually abort the
   upstream request? Are retrieval size and token spend bounded?

## Output
Findings ranked by severity with `file:line` evidence and the concrete fix.
Flag `security-architect` when output influences a control/command path, and
`privacy-counsel` when personal data reaches the model or a vendor.
