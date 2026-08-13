# Prompt Cache Sistemi Mimari İncelemesi

**Tarih:** 2026-08-13
**Tür:** Salt-okunur analiz (hiçbir kaynak dosya değiştirilmedi)
**Kapsam:** `system-prompt-builder.ts` (cache_control marker'ları, skill cache alanları, skill'lerin her build'de yeniden okunması), agent-loader cache-key türetimi (env-var yolları dahil), family/CLI seviyesi cache katmanları, Telegram plugin akışı (inbound → prompt preview → outbound) ve cache/güvenlik etkileşimi.

---

## 1. İncelenen dosyalar

| Dosya | Rol |
|---|---|
| `packages/core/src/core/system-prompt-builder.ts` | `DefaultSystemPromptBuilder` — region'lar (core/session/volatile), cache_control marker'ları, skill/env/toolsUsage/identity cache'leri |
| `packages/cli/src/boot/system-prompt-builder.ts` | CLI tarafında builder'ın DI container'a bağlanması (contributor'lar, planPath, skillLoader wiring) |
| `packages/core/src/core/system-prompt-environment.ts` | `## Environment` bloğu ve `envCacheByRoot` composite key'i |
| `packages/core/src/core/system-prompt-memory-skills.ts` | Memory + Active Skills bölümü, `skillBodyCache`, online-agents fingerprint cache'i |
| `packages/core/src/core/agent-response.ts` | Prompt epoch stabilizasyonu, `partitionPromptEpoch` (stable vs tail), `deriveCachePrefixKey` kullanımı, live-context tail |
| `packages/core/src/types/system-prompt.ts` | `flattenSystemPromptRegions` |
| `packages/core/src/utils/cache-key.ts` | `deriveCachePrefixKey` (WeakMap + sha-256 routing key) |
| `packages/core/src/coordination/agents/agent-prompts.ts` | `agentPrompt()` — rol prompt'u çözümleme, `promptCache` / `candidateCache` |
| `packages/core/src/coordination/agents/project-agent-identity.ts` | `buildProjectContextualizedPrompt` — identity/learned/consolidated overlay, learned.md yazımı |
| `packages/providers/src/cache-breakpoint-cap.ts` | Anthropic 4-breakpoint tavanı (`capAnthropicCacheBreakpoints`) |
| `packages/providers/src/prompt-cache-key.ts` | OpenAI-family `prompt_cache_key` uygulaması |
| `packages/providers/src/family-capabilities.ts` | Family bazında `cacheControl: 'native' | 'auto' | 'none'` eşlemesi |
| `packages/providers/src/presets/anthropic.ts` | Wire body inşası, ttl yerleşimi, cap çağrısı, system blok klonlama |
| `packages/telegram/src/bot.ts` | Inbound allowlist, buffer, approval callback akışı |
| `packages/telegram/src/index.ts` | Plugin setup — system prompt contributor, mailbox köprüsü, outbound kuyruk |
| `packages/telegram/src/tools/telegram-send.ts` | `telegram_send` tool'u (scrub → truncate → allowlist) |
| `packages/telegram/src/security/outbound.ts` | `scrubTelegramOutboundText`, `resolveTelegramOutboundTarget` |

---

## 2. Bulgular

### B1 — `agentPrompt` cache'i, süreç içinde DEĞİŞEN dosyaları "değişmez" varsayıyor (en kritik bulgu)

- **Referans:** `packages/core/src/coordination/agents/agent-prompts.ts:8-13` (cache yorumu), `agent-prompts.ts:154-209` (`agentPrompt`); tetikleyici: `packages/core/src/coordination/agents/project-agent-identity.ts:457-636` (`buildProjectContextualizedPrompt`) ve `project-agent-identity.ts:1097` (`learned.md` yazımı).
- **Sorun:** `promptCache`'in başındaki yorum *"Prompt files do not change during a process lifetime"* diyor ve cache `(envDir, policyOn, projectRoot, id)` ile süresiz memoize ediliyor. Ancak cache'lenen string, `buildProjectContextualizedPrompt` aracılığıyla `identity.md`, `learned.md` ve `consolidated.md` içeriğini de gömüyor — ve bu dosyalar süreç içinde **bilinçli olarak değiştiriliyor**: `captureLearnedFromAgentOutput` her capture'da `learned.md`'yi yeniden yazar (`writeTextAtomically`, satır 1097).
- **Neden öne çıkıyor:** Kodun kendi dokümantasyonu capture→inject geri-besleme döngüsünü açıkça vaat ediyor (`project-agent-identity.ts:527-532` — *"preserving the capture→inject feedback loop"*). Cache yüzünden aynı process içinde capture edilen bilgi, bir sonraki subagent spawn'ının prompt'una **hiç girmiyor**; process restart'ı gerekiyor. Yani döngü fiilen kopuk. Sessiz bir staleness: ne log var ne invalidation hook'u.
- **Önerilen yön:** `promptCache` key'ine overlay dosyalarının mtime/fingerprint'ini eklemek ya da capture yazım yolunun çağıracağı bir `invalidateAgentPromptCache()` export etmek. Alternatif: overlay'i cache dışında tutup sadece disk-prompt kısmını memoize etmek.

### B2 — Env-var cache-key şartı sağlanıyor, ancak isim farkı ve iki tutarsızlık var

- **Referans:** `agent-prompts.ts:159-169`.
- **Durum (doğrulanmış):** Kapsamda `WRONGSTACK_AGENT_AGENT_INSTRUCTIONS_DIR` olarak anılan değişken kodda **`WRONGSTACK_AGENT_INSTRUCTIONS_DIR`** (tek "AGENT"). Bu env var cache key'ine **dahil** (`${envDir}\0${policyOn}\0${promptProjectRoot}\0${id}`, satır 169); env var değişimi cache'i geçersiz kılıyor. `WRONGSTACK_AGENT_POLICY` ve `WRONGSTACK_PROJECT_ROOT`/`cwd` de key'de. Bu şart yerine getirilmiş.
- **Tutarsızlık a:** `agentPromptDirCandidates` (satır 212) profil-instructions dizinini `process.cwd()`'den türetirken `agentPrompt` içerik key'i `WRONGSTACK_PROJECT_ROOT || cwd` kullanıyor (satır 168). İkisi farklıysa, key'deki root ile aday dizin listesindeki root birbirinden kopuyor.
- **Tutarsızlık b:** `buildProjectContextualizedPrompt` env var set olduğunda overlay'i tamamen atlıyor (`project-agent-identity.ts:466-470`). Bu bilinçli (byte-equality), ama B1 ile birleşince env-var yolunun davranışı "her zaman taze disk okuması gibi görünen ama aslında cache'li" bir hal alıyor — test yazanları yanıltabilir.

### B3 — Tech-policy gövdesi global memoize; env-dir değişimine kör ve env-dir'i hiç aramıyor

- **Referans:** `agent-prompts.ts:31` (`techVersionPolicyBody`), `agent-prompts.ts:99-104` (`loadTechVersionPolicy`), `agent-prompts.ts:120-152` (`policyBody`).
- **Sorun:** İki katmanlı problem: (1) `techVersionPolicyBody` modül-genelinde tek kez memoize ediliyor; `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` değişse bile policy gövdesi yeniden çözümlenmiyor — `promptCache`'in env-dir key'lemesiyle çelişen bir davranış. (2) `policyBody()`'nin aday listesi env-dir'i **hiç içermiyor**; kullanıcı instructions dizinini override ettiğinde `_policy/tech-version.md`'yi oraya koyması bir şey değiştirmiyor.
- **Önerilen yön:** Policy gövdesini de env-dir key'li memoize etmek ve aday listesine `path.join(envDir, '_policy/tech-version.md')` eklemek.

### B4 — `_toolsUsageCache` key'i `subagent` ve model-capabilities içermiyor (`_identityCache` ile tutarsız)

- **Referans:** `packages/core/src/core/system-prompt-builder.ts:585-587` (cache kontrolü) vs `system-prompt-builder.ts:502-508` (identity cache key'i `subagent` dahil); bağımlılıklar: satır 571/646-648 (çıktı `ctx.subagent`'a bağlı) ve satır 797-798 (context-management threshold'u `modelCapabilities().maxContextTokens`'a bağlı).
- **Sorun:** Layer-2 metni `tplCtx.subagent` ile render ediliyor ama cache key'i sadece `toolsRef + tier`. Aynı builder instance'ı önce host sonra subagent (ya da tersi) için aynı tools-array referansıyla build ederse, ikinci build birincinin metnini döndürür — subagent'a host yönergeleri (ya da host'a subagent kırpılmış metni) sızar. Aynı şekilde canlı `/model` geçişinde context-window threshold'u (`<=32k → %50`) eski modele göre cache'lenmiş metinle kalır.
- **Neden öne çıkıyor:** Hemen yanındaki `_identityCache` aynı problemi `subagent`'ı key'e alarak çözmüş; iki cache'in key disiplini tutarsız. "Aynı instance paylaşılır mı?" sorusu host-bağımlı olduğu için sessiz bir tuzak.
- **Önerilen yön:** `_toolsUsageCache` key'ine `subagent` ve `maxContextTokens` eklemek (identity cache ile aynı triple + caps).

### B5 — Environment cache key'i tarihi içermiyor: geceyarısı sonrası bayat "Today's date"

- **Referans:** `packages/core/src/core/system-prompt-environment.ts:38-47` (cacheKey) ve satır 54 (`today` hesabı), 86/98 (render).
- **Sorun:** `today` bloğa yazılıyor ama composite key'e girmiyor. Uzun ömürlü process'te (eternal autonomy, daemon) geceyarısından sonra prompt hâlâ dünün tarihini taşır. Ayrıca `modeId` (satır 109-111) da key'de yok — pratikte static bir opt, ama key'lemeyen cache bu varsayımı sessizce donduruyor.
- **Ek not:** `system-prompt-builder.ts:188-194` yorumu cache'i *"keyed by projectRoot"* diye tanımlıyor; gerçek key composite (root+provider+model+caps+skillCache). Dokümantasyon drifti.
- **Önerilen yön:** Key'e `today` (ve savunmacı olarak `modeId`) eklemek; yorumu gerçek key yapısıyla güncellemek. Tarih bilinçli olarak günde bir kez dönsün isteniyorsa bunu yorumla sabitlemek.

### B6 — `capAnthropicCacheBreakpoints`: pinned marker'lar tavanı aşabilir — "en fazla 4" kontratı sessizce bozuluyor

- **Referans:** `packages/providers/src/cache-breakpoint-cap.ts:110-127` (pinned'ler koşulsuz `keep`'e alınıyor; `while (keep.size < limit)` sadece eksikken dolduruyor, fazlayken budama yok); besleyici: `packages/providers/src/presets/anthropic.ts:82-85` (ttl marker'ı cap'ten **önce** ekleniyor → pinned).
- **Sorun:** Fonksiyonun dokümante kontratı *"ensure at most `limit` cache_control breakpoints reach the wire"*. Ama ttl-pinned marker sayısı (embedder'lar `req.cache.ttl` + message boundary kombinasyonlarıyla) limite ulaştığında/aştığında fonksiyon sadece pinned-olmayanları düşürüyor; sonuç hâlâ >4 marker olabilir ve Anthropic `400 invalid_request` döner — tam da bu fonksiyonun engellemek için var olduğu hata. Uyarı/telemetry de yok.
- **Önerilen yön:** Pinned sayısı ≥ limit olduğunda bunu görünür kılmak (warn + metrik) ve kontratı ya "pinned'ler korunur, fazlası caller'ın sorumluluğu" diye daraltmak ya da pinned seçiminde önceliklendirme yapmak.

### B7 — ttl yerleşimi marker'sız system prompt'a marker EKLEYEBİLİYOR

- **Referans:** `packages/providers/src/presets/anthropic.ts:82-85` + `findDeepestMarkedBlock` (`anthropic.ts:283-311`, özellikle 302-309'daki fallback).
- **Sorun:** Hiç marker yoksa fallback, son system bloğuna `cache_control + ttl` **ekliyor**. Bu bilinçli ("eski kontratı koruma") ama iki yan etkisi var: (1) cap'in *"never adds a marker"* güvencesi sadece cap fonksiyonu için geçerli; wire'a toplam marker sayısı bu yoldan artabiliyor ve B6'daki pinned-overflow senaryosunu besliyor. (2) Marker-less embedder prompt'larında 1 saatlik cache-write, muhtemelen sığ bir prefix'e sabitleniyor — maliyet etkisi embedder'a göre değişir.
- **Önerilen yön:** Fallback'i kontrat dokümanında açıkça "bilinçli marker ekleme" olarak işaretlemek; pinned marker eklenmeden önce toplam marker sayısını hesaba katmak.

### B8 — Telegram inbound metni mailbox'a "outbound secret scrubber" ile gönderiliyor — yanlış güvenlik aracı

- **Referans:** `packages/telegram/src/index.ts:254-258` (mailbox köprüsü), `packages/telegram/src/security/outbound.ts:71-78` (`scrubTelegramOutboundText` = `DefaultSecretScrubber` + bot-token regex + `redactSecrets`).
- **Sorun:** Inbound Telegram metni güvenilmez kullanıcı girdisi. Köprü onu leader mailbox'ına `note` olarak iletirken bir **credential redactor**'dan geçiriyor — bu araç secret sızdırmayı önler, prompt-injection'ı değil. Kod tabanının başka yerlerindeki güvenilmez-içerik muamelesiyle karşılaştırın: memory-evidence fence'i (`agent-response.ts:131-147`, delimiter neutralizasyonu ile) ve WS-016 project-instructions delimiter'ı (`system-prompt-builder.ts:65-84`). Telegram inbound'da böyle bir fencing yok; metin agent context'ine "not" olarak düz giriyor. Ek olarak scrubber meşru içerikte false-positive redaction üretebilir.
- **Önerilen yön:** Inbound metni mailbox'a yazmadan önce untrusted-content delimiter'ı (provenance banner) ile sarmak; scrubber'ı ek katman olarak korumak. Mailbox trust-boundary dokümantasyonunda telegram-kaynaklı notların "evidence, not instructions" olduğunu açıkça belirtmek.

### B9 — Telegram contributor'ın cache etkileşimi doğru kurgulanmış; tek zayıf nokta count churn'ü (bilgilendirme)

- **Referans:** `packages/telegram/src/index.ts:337-350`; taşıyıcı: `system-prompt-builder.ts:398-409` (contributor'lar volatile'a, `'contributor'` tag'i ile) ve `agent-response.ts:157-199` (`partitionPromptEpoch` — volatile kaynaklar marker'sız kopyayla tail'e).
- **Durum (doğrulanmış):** System prompt'a yalnızca **okunmamış mesaj sayısı** giriyor; metin `telegram_read` tool sınırının arkasında. Contributor bloğu `'contributor'` tag'i sayesinde stable `system`'den ayrılıp live-context tail'e taşınıyor, `cache_control`'ü sıyrılıyor — yani her gelen mesaj provider prefix cache'ini bozmuyor. Bu, kapsamdaki "inbound → preview → cache" zincirinin doğru çalışan kısmı.
- **Zayıf nokta:** Count her inbound mesajda değiştiği için tail byte'ları her istekte farklı; tail deep-boundary sonrasında olduğundan bu sadece re-tokenizasyon (cache-write yok) — kabul edilebilir, ama bilinmeli.
- **Küçük not:** `bot.ts:498-509` — allowlist'te olmayan kullanıcıya reddetme mesajı **gönderiliyor**; grup sohbetlerinde spam/keşif vektörü (kodda bilinçli kabul edilmiş, yorumu var).

### B10 — Outbound yolu sağlam: doğru sıralama ve allowlist (doğrulanmış, bulgu yok)

- **Referans:** `packages/telegram/src/tools/telegram-send.ts:54-65`, `outbound.ts:32-64`.
- **Doğrulananlar:** Scrub truncation'dan **önce** (credential hiç parçalanmıyor, satır 56-59); outbound hedef paired-chat + açık allowlist'e karşı doğrulanıyor; tool `permission: 'confirm'` + `NET_OUTBOUND` capability. Approval akışı (`bot.ts:555-624`) request-id + chat + user + message-id + expiry bağlı — sağlam. Bu alanda glaring bug yok.

---

## 3. Mimari genel değerlendirme (doğru çalışan iskelet)

- **Üç-bölgeli ayrım** (core/session/volatile) ve `partitionPromptEpoch`'un volatile blokları marker'sız kopyayla tail'e taşıması (`agent-response.ts:180-199`) sağlam; `deriveCachePrefixKey`'in sadece stable partition üzerinden türetilmesi (`agent-response.ts:471`) sayesinde plan/glossary/peers churn'ü OpenAI `prompt_cache_key` partition'ını değiştirmiyor.
- **Skill'lerin her build'de yeniden okunması** (`system-prompt-builder.ts:277-317`) bilinçli ve güvenli: disk I/O `SkillLoader`'ın internal cache'inde; env bloğu key'i `skillCache`'i içerdiğinden (`system-prompt-environment.ts:46`) manifest değişimi env cache'ini doğru invalidete ediyor. `skillBodyCache` alanı ise ismine rağmen gerçek bir cache değil — her build'de yeniden hesaplanan bir state-threading alanı (`system-prompt-memory-skills.ts:164-183`); davranış doğru, isimlendirme yanıltıcı.
- **Env-var cache-key şartı** (B2) karşılanıyor; `WRONGSTACK_AGENT_INSTRUCTIONS_DIR` + policy flag + project root hepsi key'de.
- **Anthropic wire hijyeni:** system blokları wire için taze, field-allowlisted kopyalar olarak üretiliyor (`anthropic.ts:66-75`) — cap'in in-place `delete cache_control`'ü builder state'ini kirletmiyor. Cap'in normal yolu (ilk + son + pinned + ikinci-en-yeni message marker + gap-fill) makul.

---

## 4. Varsayımlar / doğrulanamayanlar

- **B4'ün pratik etkisi:** `_toolsUsageCache`'in `subagent` karışması ancak aynı builder instance'ının host ve subagent build'lerinde paylaşılmasıyla tetiklenir. CLI wiring'i (`packages/cli/src/boot/system-prompt-builder.ts:181-241`) her `bind` factory çağrısında yeni instance üretiyor; container'ın resolve başına yeni instance mı yoksa singleton mı döndürdüğü bu incelemede doğrulanmadı. Singleton ise bulgu kritikleşir.
- **B6'daki pinned-overflow senaryosu** hiç test/wire log'u ile gözlemlenmedi; statik analizden türetilmiş bir edge case.
- **Tier-bağımlı küçük staleness'ler** (ör. `renderOnlineAgents` fingerprint'i tier içermiyor — `system-prompt-memory-skills.ts:51-61`) `tokenSavingMode`'un `readonly opts` üzerinden instance-ömürlü olması nedeniyle pratikte etkisiz; builder'ı farklı tier ile yeniden kullanan embedder'lar için not edildi.
- `composeRequestMessages` (deep cache boundary'nin messages içine yerleşimi) detaylı okunmadı; tail'in boundary sonrasına düştüğü `agent-response.ts:412-431` yorumları ve partition mantığından doğrulandı.

---

## 5. Öncelik özeti

| # | Bulgu | Şiddet | Tek cümlelik yön |
|---|---|---|---|
| B1 | learned.md/identity.md değişse de `promptCache` invalidasyonu yok | **Yüksek** | Overlay dosyalarını key'e kat ya da capture yolundan invalidate çağır |
| B8 | Inbound Telegram metni injection-fencing olmadan mailbox'a | **Yüksek** | Untrusted-content delimiter ile sar |
| B4 | `_toolsUsageCache` key'inde `subagent`/caps yok | Orta | Key'i identity cache ile hizala |
| B6 | Pinned marker'lar 4-breakpoint tavanını aşabilir | Orta | Overflow'u görünür kıl / kontratı daralt |
| B5 | Env cache'inde tarih yok → bayat "Today's date" | Düşük-Orta | Key'e `today` ekle |
| B3 | Tech-policy memoization'ı env-dir'e kör | Düşük | Env-dir key'le + adaylara ekle |
| B2a | cwd vs `WRONGSTACK_PROJECT_ROOT` tutarsızlığı | Düşük | Tek root kaynağına indir |
| B7 | ttl fallback marker ekleyebiliyor | Düşük | Dokümante et + cap hesabına kat |
