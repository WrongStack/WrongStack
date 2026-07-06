# 03 — Multi-Provider

Switching providers and configuring custom OpenAI-compatible endpoints.

> Every model id below is verified against the current
> [`models.dev/api.json`](https://models.dev/api.json) catalog. Run
> `wrongstack models <provider>` to see the full live list for any
> provider.

## Switch at launch

```bash
# Anthropic
wrongstack --provider anthropic --model claude-opus-4-7 "explain the agent loop"
wrongstack --provider anthropic --model anthropic-test-model "explain the agent loop"
wrongstack --provider anthropic --model claude-haiku-4-5 "explain the agent loop"

# OpenAI
wrongstack --provider openai --model gpt-5.5 "explain the agent loop"
wrongstack --provider openai --model gpt-5.5-pro "explain the agent loop"

# Groq (fast + cheap)
wrongstack --provider groq --model llama-3.3-70b-versatile "explain the agent loop"

# DeepSeek
wrongstack --provider deepseek --model deepseek-v4-pro "explain the agent loop"

# Z.AI coding plan
wrongstack --provider zai-coding-plan --model glm-5.1 "explain the agent loop"

# Google
wrongstack --provider google --model gemini-3-pro-preview "explain the agent loop"

# OpenRouter — access to any model through one endpoint
wrongstack --provider openrouter --model anthropic/claude-opus-4-7 "explain the agent loop"
```

## Switch at runtime

Inside the TUI:

```
/model                  # interactive provider → model picker (aliases: /provider, /switch)
```

The CLI (plain REPL) doesn't ship a runtime model picker — restart with
`--provider` / `--model`, or `wstack config` to set a persistent default.

## Custom endpoint (Ollama, local)

```jsonc
// ~/.wrongstack/config.json
{
  "providers": {
    "ollama": {
      "family": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama"   // any non-empty string; Ollama ignores it
    }
  }
}
```

```bash
wrongstack --provider ollama --model llama3.3 "hello"
```

## Custom endpoint (self-hosted, encrypted key)

```jsonc
{
  "providers": {
    "my-llm": {
      "family": "openai-compatible",
      "baseUrl": "https://llm.internal.company.com/v1",
      "apiKey": "enc:v1:<iv>:<tag>:<ciphertext>"
    }
  }
}
```

Add the encrypted key non-interactively with:

```bash
wrongstack auth my-llm
```

WrongStack encrypts what you paste with AES-256-GCM and writes it back
to `config.json`.

## Fallback pattern

Configure multiple providers so you can switch providers when one is
rate-limited:

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:..." },
    "openai":    { "apiKey": "enc:v1:..." },
    "groq":      { "apiKey": "enc:v1:..." }
  }
}
```

Then re-launch with `--provider openai` or open `/model` from the TUI
to swap mid-project without losing the session.

## Refresh the catalog

The models.dev catalog is cached for 24 h. To force a refresh:

```bash
wrongstack models refresh
```
