# HQ Key Vault — merkezi anahtar/auth yönetimi (taslak tasarım, 2026-11-23)

Durum: onaylandı (2026-11-23). **P0 sunucu tarafı, P1 HQ "Keys" ekranı ve P2 istemci (CLI + `/auth` + TUI) uygulandı (2026-11-24)**; P3–P5 açık.

P2: `packages/cli/src/hq-vault/` — `device-store.ts` (`hq-device.json`), `service.ts`
(`HqCredentialService`: enroll / list / importKeys / sync / unenroll, tek yazıcı `mutateConfigProviders`),
`flow.ts` (menü + TUI ortak akışı). Komutlar: `wstack hq enroll|device|sync|unenroll`,
`wstack auth import --from hq`; `wstack auth` menüsünde `h`; TUI `/auth` panelinde "Import from HQ"
(`AuthPanelHost.importFromHq`). `ProviderApiKey.source` (alan adları secret desenine takılmaz).
Lease grant'ler P4'e kadar listelenir ama diske yazılmaz.

P1: hq-next System → Keys (`packages/hq-next/src/features/vault/`): kapı paneli (parola yok / mühürlü / güvensiz kanal / kilitli / açık; unseal ve step-up formları), anahtarlar (ekle, değiştir, sil — değer hiç geri okunmaz), cihazlar (kayıt kodu üret + `wstack hq enroll <url> <token>` komutu, onay, iptal, parmak izleri), anahtar × cihaz erişim matrisi, etkinlik günlüğü (`GET /api/vault/audit`).

### P0'da uygulanan (tasarımdan sapmalar dahil)
- Kripto + depo + protokol + cihaz yardımcıları `packages/hq/src/vault/` altında (`crypto.ts`, `master-key.ts`,
  `store.ts`, `protocol.ts`, `client.ts`). `core/security` yerine `hq`: core public API snapshot'ına dokunmamak için.
- Dosyalar tek tek değil: `<dataDir>/hq-vault.json` (kimlik + secret'lar + cihazlar + grant'ler, tek atomik yazıcı),
  `<dataDir>/hq-vault-master.key`, `<dataDir>/hq-vault-audit.jsonl`. HQ kimlik özel anahtarları master ile şifreli
  olarak `hq-vault.json` içinde (ayrı `hq-signing.key` yok). deviceId = sha256(her iki public key)[:32 hex].
- Yetki: yeni token capability'si **eklenmedi**. Operatör uçları mevcut `requireAdminCredential` /
  `callerCanAdministerAuth` (`auth.admin`) ile; cihaz uçları token değil cihaz imzası/kayıt MAC'i ile doğrulanıyor,
  bu yüzden `projectAuthFile`'a ikinci bir kapı eklemek gerekmedi.
- Step-up: parola + (2FA açıksa) TOTP, ikisi birden; 10 dk, onu kanıtlayan kimlik bilgisine bağlı.
- Yerleşik TLS: `--tls-cert/--tls-key` (env `WRONGSTACK_HQ_TLS_CERT/KEY`), her iki HQ giriş yolunda.
- Route'lar ve kurallar: [HQ komut referansı → Key vault](../subcommands/hq.md#key-vault).
- Testler: `packages/hq/tests/vault-store.test.ts`, `packages/cli/tests/hq-vault-routes.test.ts`,
  `packages/cli/tests/hq-tls.test.ts`, sensitivity testlerine eklenen vakalar.

## 1. Bugünkü durum (kanıtlı)

**İstemci**
- Anahtarlar profil config'inde: `<WRONGSTACK_HOME>/profiles/<ad>/config.json` → `providers.<id>.apiKeys[]`
  (`ProviderApiKey`, `packages/contracts/src/types/config/providers.ts:6-61`, `ProviderConfig` :63).
- Diskte şifreleme: `SecretVault` AES-256-GCM, `enc:v<N>:iv:tag:ct`, anahtar `~/.wrongstack/.key`
  (`packages/core/src/security/secret-vault.ts`, `secret-vault-key-file.ts`). Hangi alanın şifreleneceğini
  alan adı belirler: `isSecretField` (`core/src/security/config-secrets.ts:114-125`).
- Tek yazma yolu: `mutateConfigProviders` (`packages/cli/src/provider-config-utils.ts:183`), okuma
  `loadConfigProviders` (:120). Canlı yeniden yükleme: `watchProviderConfig`
  (`core/src/storage/provider-config-watcher.ts:223`) — dosya değişince süreç yeni anahtarı alır.
- OAuth token'ları da aynı `ProviderApiKey` içinde (`authMethod: 'oauth'`, `refreshToken`); yenileme
  `applyProviderOAuthRefresh` (`providers/src/provider-credential-state.ts:75`). MCP OAuth ayrı:
  `<projectDir>/mcp-auth.json`.
- Öncelik: kayıtlı anahtar > env (`OPENAI_API_KEY` vb.) > keyless local (`providers/.../provider-build.ts:197-241`).
- `hq` alanı in-project config deny listesinde (`core/src/storage/config-loader/in-project-policy.ts:111`) —
  klonlanan repo HQ adresini değiştiremez. İyi; vault bunun üstüne kurulabilir.
- Mevcut iki sync sistemi bilerek secret taşımıyor (`cloud-config-sync/sanitize.ts`, "Secrets never sync").

**Giriş yüzeyleri (hepsi sonunda `mutateConfigProviders`)**
| Yüzey | Dosya |
|---|---|
| `wstack auth …` | `packages/cli/src/subcommands/handlers/auth.ts` (+ `auth-menu/direct.ts`, `local.ts`, `provider-auth-login.ts`, `openai-codex-oauth.ts`, `github-copilot-oauth.ts`) |
| `/auth` slash | `packages/cli/src/slash-commands/auth.ts` → TUI paneli |
| TUI menüleri | `auth-menu/top-menu.ts`, `provider-menu.ts`, `add-provider.ts`, `panel-service.ts` |
| WebUI | protokol `packages/webui-protocol/src/client-workspace.ts:60-83`, sunucu `packages/webui-server/src/server/provider-routes.ts`, `provider/keys.ts`, `provider/oauth.ts` |
| VibeUI | `packages/vibeui/src/components/provider-manager.tsx` (WS üzerinden WebUI sunucusu) |
| Desktop v2 | `apps/desktop-v2/src/ProviderSettings.tsx`, `provider-settings-model.ts`, `ProviderOAuth.tsx` (WS üzerinden) |

**HQ**
- Sunucu `packages/cli/src/hq-server.ts` (+ `hq-server/routes.ts`, `upgrade-handler.ts`, `ws.ts`); protokol/store'lar
  `packages/hq`. Arayüz `packages/hq-next` (fetch: `src/hq/data/api.ts`).
- Kimlikler: browser token, operatör parolası (+TOTP), client token. Yetki = capability listesi
  (`auth-content-hash.ts`); tek projeksiyon `projectAuthFile` / `callerCanAdministerAuth`.
- **Client token'ları `auth.json`'da açık metin.** Makine kimliği kriptografik değil:
  `stableMachineId = sha256(hostname)[:12]` (`hq/src/factory.ts:192`), roster anahtarı `host:<hostname>`.
- **TLS yok** (`http.createServer`); non-loopback + auth = yalnızca uyarı (`hq/src/exposure.ts:103`).
- HQ→istemci komut kanalı var (`acp-config` emsali): `POST /api/command` → bellek kuyruğu →
  `client.command_poll` → `client.command_ack`. Payload ve ack `commands.jsonl`'a yazılıyor ve tarayıcılara
  yayınlanıyor → **secret bu kanaldan geçemez.**
- HQ'da hiç at-rest şifreleme yok; provider/anahtar ekranı yok.
- `packages/hq` zaten `@wrongstack/core`'a bağımlı → kripto yardımcıları `core/security` içinde, vault'un yanına.

**Kanıt (2026-11-23, geçici betik):** X25519 ECDH + HKDF-SHA256 + AES-256-GCM (AAD bağlı),
Ed25519 imza, HMAC kayıt MAC'i Bun 1.4.5 ve Node 26'da çalışıyor; AAD kurcalaması reddediliyor.

## 2. Tehdit modeli

HQ "taç mücevheri" olur: ele geçen HQ = tüm anahtarlar. Korunacaklar: (a) HQ diski/yedeği çalınırsa anahtarlar
okunamasın (zarf şifreleme + opsiyonel parola mühürü); (b) HQ ile istemci arasındaki ağ (bugün düz HTTP) pasif
dinlemede ve sahte HQ'da anahtar sızdırmasın (cihaza mühürlü uçtan uca şifreleme + kayıtta sabitlenmiş HQ imza
anahtarı); (c) çalınan bir client token tek başına hiçbir şey açmasın (cihaz imzalı istek + cihaz public key'ine
mühür); (d) HQ, istemcinin provider `baseUrl`/header'ını değiştirip anahtarı başka hosta yollayamasın (WS-06 deseni).
Korunamayan: istemcide bir kez çözülmüş anahtarı HQ geri alamaz — gerçek iptal, provider tarafında rotasyondur.
Ayrıca düz HTTP'de tarayıcıdan HQ'ya yapıştırılan anahtar açık gider (`crypto.subtle` yalnız HTTPS/localhost'ta var).

## 3. Mimari

### 3.1 HQ tarafı: vault store
- `<dataDir>/vault/`:
  - `master.key` (0600): HQ ana anahtarı (KEK). Opsiyonel `WRONGSTACK_HQ_VAULT_PASSPHRASE` ile scrypt-sarmalı
    (mevcut `deriveKEK`/`wrapDataKey` yeniden kullanılır). Parola modunda HQ açılışta "mühürlü"; vault web'den
    açılana kadar istek reddedilir.
  - `secrets.json`: her secret için ayrı DEK (AES-256-GCM), DEK master ile sarılı. Kayıt:
    `{ id, providerId, label, kind: 'api_key'|'oauth'|'header', version, createdAt, rotatedAt, ciphertext, wrappedDek }`.
  - `devices.json`: `{ deviceId = sha256(x25519Pub‖ed25519Pub)[:16], x25519Pub, ed25519Pub, hostname, profile,
    status: pending|approved|revoked, enrolledAt, lastFetchAt }`.
  - `grants.json`: `{ id, secretId, deviceId | group, policy: 'local'|'lease', leaseTtl?, setActive: bool, expiresAt? }`.
  - `hq-signing.key`: HQ Ed25519 imza anahtarı + X25519 anahtarı (istemciden HQ'ya yükleme için).
  - `vault-audit.jsonl`: kim ne ekledi/verdi/iptal etti, hangi cihaz ne zaman çekti. Asla secret yok.
- Yeni capability'ler: `vault.admin` (secret/grant/cihaz yönetimi), `vault.fetch` (cihaz). **Mevcut
  `projectAuthFile` / `callerCanAdministerAuth` üzerinden** — ikinci kapı yok. Admin yazma işlemleri
  step-up ister (parola + TOTP son N dakika). **Operatör parolası tanımlı değilse vault etkinleşmez** (taze kurulumda
  yalnız browser token var; parola yokken step-up "herhangi bir `vault.admin` token"a dönüşürdü). TOTP önerilir.
- Yeni secret dosyaları agent-state kapısına girer: istemcide `hq-device.json`, HQ'da `vault/master.key`,
  `hq-signing.key`, `secrets.json` → `core/src/security/agent-state-sensitivity.ts` secrets kümesi + okuma tarafı
  `isProtectedAgentStatePath` (basename). Yoksa ajanın kendi dosya araçları cihaz anahtarını okuyabilir.

### 3.2 Cihaz kaydı (enrollment)
1. HQ arayüzü → Cihazlar → "Cihaz ekle": tek kullanımlık kayıt kodu (bootstrap-store deseni, 10 dk TTL) +
   HQ URL + HQ parmak izi gösterilir.
2. İstemci: `wstack hq enroll <url> --code <kod>` (veya "HQ'dan içe aktar" ilk kez seçilince sorulur).
   X25519 + Ed25519 anahtar çifti üretir; özel anahtarlar `~/.wrongstack/hq-device.json` içinde yerel vault ile
   şifreli. Gönderir: public key'ler + nonce + hostname/profil, hepsi **kod ile HMAC'lı**.
3. HQ: MAC'i doğrular, cihazı kaydeder, kapsamlı client token (`vault.fetch` + `telemetry.publish`) ve kendi imza
   public key'ini **aynı kodla MAC'lı** döner. İstemci HQ anahtarını sabitler (pin). İki tarafta parmak izi gösterilir.
4. Kod admin tarafından üretildiyse cihaz otomatik `approved`; aksi halde `pending` → admin onayı.

Böylece düz HTTP'de bile ortadaki adam kayıt anında anahtar değiştiremez (kodu bilmiyor).

### 3.3 Dağıtım (fetch)
- Ayrı kanal: WS `client.vault_fetch` → `hq.vault_bundle` (veya `POST /api/vault/fetch`). **Komut kuyruğu/audit/
  broadcast dışında.** `redaction.ts`'e tipleri eklenir, testle sabitlenir.
- İstek cihazın Ed25519 imzasını taşır (timestamp + nonce + istenen secret id'leri) → token çalınsa da işe yaramaz.
- Yanıt: her secret için HPKE benzeri mühür — geçici X25519 + HKDF-SHA256 + AES-256-GCM,
  AAD = `wstack-hq-vault/v1|deviceId|secretId|version|grantId`; tüm paket HQ Ed25519 ile imzalı.
- Bildirim: secret dönünce/iptal edilince HQ `credential-sync` komutu atar, **sadece id+versiyon** içerir;
  istemci gelip fetch eder.

### 3.4 İstemci tarafı: `HqCredentialService`
- Tek servis (cli/runtime): `status()`, `listAvailable()`, `import(ids, { profile })`, `syncAll()`, `unenroll()`.
- Varsayılan saklama: mührü aç → **mevcut yerel vault ile yeniden şifrele** → `mutateConfigProviders` ile
  `providers.<id>.apiKeys[]`'e yaz. Provider çözümleme hiç değişmez, çevrimdışı çalışır. "Benim anahtarımla
  şifrele, şifreli halini ver" isteği taşıma katmanında karşılanır. (Mühürlü blob'u diskte saklamak, cihaz özel
  anahtarı `.key`'in yanında durdukça ek güvenlik vermez; OS keystore gelince anlamlı → sonraki faz.)
- `ProviderApiKey`'e `source?: { kind: 'hq'; hqId; secretId; version; grantId; policy }` eklenir. Key materyali
  taşıyan her alan `isSecretField`'e uymalı (yoksa sessizce düz metin yazılır) — testle sabitlenir.
- HQ'dan gelen anahtar yalnız **credential alanlarını** yazar; `baseUrl`/header/endpoint'e dokunmaz (WS-06).
  Katalog dışı bir provider için endpoint gerekiyorsa yerel onay istenir.
- `activeKey` yalnız grant `setActive: true` diyorsa değişir. HQ kaynaklı anahtar arayüzde "HQ yönetiminde"
  rozetiyle görünür; yerel düzenleme uyarı verir (sonraki sync ezer).
- `lease` politikası: anahtar diske yazılmaz, bellekte TTL ile tutulur, açılışta HQ'dan çekilir (HQ kapalıysa yok).
  **Bu yol provider çözümlemesini değiştirir:** `resolveActiveKey` önünde bellek-içi bir credential katmanı gerekir ve
  her süreç (TUI, WebUI sunucusu, daemon'lar) kendi lease'ini çeker — bir sürecin belleği diğerine ulaşmaz.
  "Provider kodu değişmez" yalnız varsayılan yerel-vault yolu için doğru.

### 3.5 OAuth (abonelik hesapları)
- Dönen refresh token'lar birden çok istemcide kırılır (biri yenileyince diğerleri ölür); Codex notu da
  "refreshToken VERME" diyor. Öneri: **refresh token yalnız HQ'da**, HQ tek yenileyici; istemcilere kısa ömürlü
  access token `lease` olarak verilir, süre dolunca istemci HQ'dan yenisini ister.
- Maliyeti: refresh yolu (`applyProviderOAuthRefresh` / `provider-persisters.ts`) refresh token yokken provider yerine
  HQ'dan yeni access token isteyecek bir kancaya ihtiyaç duyar; lease katmanıyla birlikte P4'te.
- Bir aboneliği farklı kişiler arasında paylaşmak provider kullanım şartları açısından kullanıcının kararı.

### 3.6 İptal
1. Grant/cihaz iptal → HQ teslimatı keser.
2. `credential-revoke` komutu (yalnız id) → istemci yerel kopyayı siler.
3. Gerçek güvenlik: provider'da anahtarı döndür → HQ'ya yeni anahtar gir → onaylı cihazlara otomatik dağılır.
HQ arayüzü bunu "Rotate" akışı olarak sunar.

### 3.7 TLS
- Vault admin yazmaları (secret ekleme, grant, reveal, **kayıt kodu üretme**) non-loopback + TLS'siz HQ'da **reddedilir**
  (`assessHqExposure` vault için uyarı yerine ret). Seçenekler: yerleşik TLS (`--tls-cert/--tls-key`),
  Tailscale serve, Caddy reverse proxy. İstemci fetch'i uçtan uca mühürlü olduğu için düz HTTP'de de güvenli.
- Kontrol gerçek sokete bakar: ham `socket.remoteAddress` loopback **veya** soket TLS. `X-Forwarded-Proto` yalnız
  `trustedProxyHops > 0` iken dikkate alınır (mevcut rate-limit asimetrisiyle aynı). Aynı makinedeki Caddy/Tailscale
  loopback sayılır; uzak proxy trusted-hop ayarı ister. Kayıt kodu da kapsamda: kod düz HTTP sayfada görünürse
  kayıttaki MAC koruması boşa çıkar.

## 4. Fazlar

| Faz | İçerik |
|---|---|
| P0 | `core/security` kripto yardımcıları (seal/open, sign/verify, enrollment MAC) + HQ vault store (zarf şifreleme, master key, parola mühürü) + cihaz kaydı + capability'ler projeksiyondan + audit + redaction testleri |
| P1 | hq-next "Anahtarlar" bölümü: Secrets, Cihazlar (parmak izi, onay, iptal), Grant matrisi, Audit; step-up |
| P2 | `HqCredentialService` + `wstack hq enroll/status/sync/unenroll` + `wstack auth import --from hq` + `/auth` üst menü "HQ'dan içe aktar" + TUI `add-provider` seçeneği |
| P3 | WebUI protokolü `hq_vault.status/list/import` → VibeUI `provider-manager.tsx` ve Desktop `ProviderSettings.tsx` butonu (aynı WS yolu, bedava) |
| P4 | Push sync (`credential-sync`), `credential-revoke`, `lease` politikası (süreç başı bellek katmanı `resolveActiveKey` önünde), merkezi OAuth yenileme (refresh yolunda HQ kancası) |
| P5 | İstemciden HQ'ya yükleme (`wstack hq keys push` — mevcut anahtarları HQ'ya taşı, HQ X25519 key'ine mühürlü); cihaz özel anahtarı için OS keystore (DPAPI/Keychain/libsecret, Tauri keyring) |

## 5. Açık kontroller (henüz YAPILMADI)
- `cloud-config-sync` `reinjectLocalSecrets` HQ kaynaklı anahtarları ve `source` alanını koruyor mu?
- `config-transfer.ts` export'u secret taşıyor mu? (grep sonuç vermedi; bu bir kanıt değil, belirsiz) (HQ-managed anahtarlar export'ta nasıl davranmalı)
- `acp-config` ack'i audit/broadcast öncesi redakte ediliyor mu (mevcut olası açık, ayrı bulgu).
- MCP OAuth (`mcp-auth.json`, proje kapsamlı) ilk sürüme dahil mi? Öneri: hayır, P5 sonrası.

## 6. Kararlar (kullanıcı, 2026-11-23)
1. Saklama: varsayılan yerel vault'a kalıcı; grant bazında `lease` seçilebilir.
2. OAuth: HQ tek yenileyici, refresh token HQ'dan çıkmaz; istemcilere access token lease.
3. Master key: 0600 dosya varsayılan; `WRONGSTACK_HQ_VAULT_PASSPHRASE` verilirse parola-mühürlü (restart sonrası web'den açılır).
4. TLS: vault admin yazmaları loopback/HTTPS dışında reddedilir; HQ'ya yerleşik TLS (`--tls-cert/--tls-key`) eklenir.
