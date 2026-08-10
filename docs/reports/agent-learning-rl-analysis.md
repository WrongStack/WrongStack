# Roster agent self-learning — RL merceğinden analiz

**Tarih:** 2026-08-10 · **Kapsam:** `packages/core/src/coordination/agents/project-agent-*`,
`packages/cli/src/fleet/host-{context,learning}.ts`

> **Durum:** Dalga 0, 1 ve 2 uygulandı (2026-08-10). Uygulama sırasında G7'nin
> yarısının hatalı bir okumaya dayandığı ortaya çıktı — düzeltme §3.G7'de.
> Dalga 3 (holdout) uygulanmadı; `applied` sayaçları birikmeden kolları
> ayırmak mümkün değil. Uygulanan davranışın kullanıcı dokümanı:
> `docs/slash/agent-improve.md`.

---

## 1. Çıkış cümlesi ve içerdiği dört zorunluluk

> "Reinforcement learning (RL) agents are autonomous software entities that learn to make
> optimal decisions by interacting with an environment through trial and error."

Cümleyi parçalarına ayırınca öğrenen bir sistemin sahip olması gereken dört şey çıkıyor:

| Cümledeki öğe | RL karşılığı | Zorunlu kıldığı mekanizma |
|---|---|---|
| *interacting with an environment* | trajectory | Aynı duruma tekrar tekrar dönebilmek |
| *trial and **error*** | negative reward | Yanlışın da kaydedilmesi ve **geri alınması** |
| *learn to make **optimal** decisions* | policy improvement | Bir davranışın diğerinden **iyi olduğunun ölçülmesi** |
| *autonomous* | closed loop | Döngünün insan düğmesine bağlı olmaması |

Bizim sistemde **1. ve 4. madde var, 2. ve 3. madde yok.** Rapor esas olarak bunu anlatıyor.

---

## 2. Mevcut döngünün kod haritası

```
                    ┌─ görev çalışır (subagent) ────────────────────┐
                    │                                              │
  spawn             ▼                                          sonuç
  host-context.ts:54  rankRoleSkills → top-3 skill          host-learning.ts:35
  host-context.ts:98  + <skill>.md addendum                 recordSkillOutcome(ok)
  host-context.ts:129 recordSkillLoad()                            │
                    ▲                                              ▼
                    │                                  identity.ts:902 capture
                    │                                  ## LEARNED → normalize →
                    │                                  route → merge → learned.md
                    │                                              │
                    │                                  host.ts:828 notifyCaptured
                    │                                              ▼
                    │                                  auto-optimize.ts:106 eligible?
                    │                                  optimizer.ts:147 distill
                    └──────────── skills/<skill>.md ◄──────────────┘
```

RL terimleriyle eşleşme:

| RL | WrongStack | Dosya |
|---|---|---|
| Environment | proje (repo, test suite, build) | — |
| Policy π | rol prompt'u = identity + consolidated + skill addenda | `identity.ts:436` |
| Action | görev yürütmesi (tool çağrıları) | agent-loop |
| Reward r | `TaskResult.status === 'success'` | `host-learning.ts:38` |
| Experience | `## LEARNED` bloğu | `identity.ts:925` |
| Replay buffer | `learned.md` (8 KB bütçeli) | `learning-structured.ts:376` |
| Policy update | distillation → `skills/<skill>.md` | `optimizer.ts:147` |
| Action selection | `rankRoleSkills` top-3 greedy | `skill-layer.ts:354` |

**Doğru kurulmuş olanlar** — bunlar gerçekten RL'in çekirdek fikirleri ve zaten yerinde:

- Döngü kapalı: capture → optimize → inject, insan düğmesi yok (`auto-optimize.ts`).
- Negatif trajectory'ler de toplanıyor: `host-learning.ts:46` başarısız/iptal görevlerden de
  capture yapıyor. Duvara toslayıp *neden*ini yazan subagent en değerli kaynak.
- Buffer bütçesi öğrenmeyi **bloklamıyor**, eviction yapıyor (`enforceLearnedBudget`) — eski
  `> LEARNED_SOFT_LIMIT` kapısı en çok öğrenen rolleri sessizce öğrenmez hale getiriyordu.
- Model yoksa deterministik fallback yazılıyor; headless kutuda da bir şey öğreniliyor.

---

## 3. RL merceğinden dokuz boşluk

### G1 — Ödül, öğrenilen içeriğe hiç dokunmuyor (kritik)

`recordSkillOutcome` sadece `affinity.json`'daki sayaçları günceller. **Hiçbir directive'in
kendi başarı/başarısızlık kaydı yok.** `StructuredLearnedEntry`
(`learning-structured.ts:16`) şu alanları taşıyor: `key, category, what, why, how,
capturedAt, skill`. Yok olanlar: `uses`, `wins`, `losses`, `sourceTaskOutcome`.

Sonuç: sistem RL değil, **self-distillation**. Ne yazılacağına ajanın kendisi karar veriyor,
çevre değil. Yanlış bir directive yazılırsa, o directive sonsuza kadar her prompt'a enjekte
edilir ve onu eleyecek tek mekanizma yaş bazlı eviction'dır.

### G2 — Credit assignment yok

`host-learning.ts:35` tek bir binary ödülü, yüklenmiş **bütün** skill'lere eşit dağıtıyor.
3 skill yüklendi, görev başarılı → üçü de +1. Hangisinin katkı yaptığı bilinmiyor.
RL'de bu "reward shaping olmadan sparse reward" durumu; öğrenme sinyali gürültünün altında
kalır.

### G3 — Skor fonksiyonu başarısızlığı ödüllendiriyor

```ts
// skill-layer.ts:337
const successRate = outcomes === 0 ? 0 : (entry.succeeded + 1) / (outcomes + 2);
return entry.learned * 2 + successRate * 3 + Math.min(entry.loaded, 10) * 0.1;
```

Sayısal davranış:

| Durum | succeeded | failed | skor |
|---|---|---|---|
| Hiç denenmemiş | 0 | 0 | **0.00** |
| 10 kez üst üste başarısız | 0 | 10 | **0.25** (+ loaded katkısı) |
| 10 kez başarılı | 10 | 0 | 3.75 |

**Üst üste on kez batıran skill, hiç denenmemiş skill'den yüksek skorluyor.** Laplace
smoothing `outcomes === 0` dalında atlandığı için "veri yok" = 0, "kötü veri" > 0.
Başarısızlık, alaka kanıtı sayılıyor.

### G4 — Maruz kalma kendini besliyor (rich-get-richer)

`Math.min(entry.loaded, 10) * 0.1` — bir skill yüklendiği **için** +1.0'a kadar puan
kazanıyor, faydası kanıtlanmadan. İlk turlarda curated sırasıyla seçilen top-3, sırf
seçildikleri için skorlanıp bir daha yerlerini bırakmıyor. RL'de bu, exploration'ı sıfır olan
greedy argmax politikasının klasik çöküşü.

### G5 — Exploration hiç yok

`rankRoleSkills` saf argmax. ε-greedy, UCB, Thompson — hiçbiri yok. `lastUsedAt` alanı
yazılıyor (`skill-layer.ts:296`) ama **skorda hiç kullanılmıyor**; yani "uzun süredir
denenmedi, bir şans ver" sinyali toplanıp çöpe atılıyor.

### G6 — Non-stationarity yok sayılıyor

Sayaçlar ömür boyu kümülatif. Proje 4 ay önce Jest'ten Vitest'e geçtiyse, Jest döneminde
biriken `succeeded` hâlâ tam ağırlıkla sayılıyor. Discount factor (γ) veya sliding window
yok. Ödül geçmişi hiç unutulmuyor — halbuki çevre değişiyor.

### G7 — Çelişki çözümü "son yazan kazanır" *(kısmen hatalı — düzeltme)*

**İlk iddia:** `mergeStructuredEntries` (`learning-structured.ts:272`) Jaccard ≥ 0.55 olan
eski entry'yi siliyor ve yenisini koyuyor; 40 görevde işe yaramış bir directive tek seferlik
bir gözlemle ezilebiliyor.

**Uygulamada ortaya çıkan gerçek:** otomatik capture yolunda bu erişilemez. `capture`
zaten aynı eşikle (`identity.ts:1005`, aynı `normalizeForComparison` anahtarı) near-duplicate
adayı **reddediyor**, dolayısıyla merge'e hiç çakışan bir aday gelmiyor — orada **eski
kazanıyor**, yeni değil. Merge'in kendi filtresi o yol için ölü kod.

Gerçek sorun ikiye ayrılıyor:

- **Öğretilen (`taught`) yolda** iddia doğru: `updateProjectAgentLearned`
  (`project-agent-files.ts:86`) ön-eleme yapmadan merge çağırıyor, orada yeni olan eskiyi
  eziyor. Kanıtlanmış directive koruması bu yolda gerçekten iş görüyor ve uygulandı.
- **Otomatik yolda** ters bir kısıt var: ilk formülasyon sonsuza kadar kazanıyor, yani bir
  directive otomatik capture ile **iyileştirilemiyor**. Bu ayrı bir eksik; capture'ın dedup
  semantiğini değiştirmek gerektiği ve mevcut testlerle sabitlenmiş olduğu için bu turda
  dokunulmadı.

`detectLearnedConflicts` (`identity.ts:802`) var ama sadece **roller arası** çalışıyor ve
çıktısı hiçbir yere beslenmiyor — saf rapor. Bu kısım değişmedi.

### G8 — Off-policy evaluation imkânsız

"Bu addendum işe yarıyor mu?" sorusunun cevabı hiçbir yerde yok. Counterfactual (addendum
olmadan aynı görev nasıl giderdi) ölçülmüyor. Baseline yok → advantage yok → policy
gradient'in işareti bile bilinmiyor.

### G9 — Trial yok, sadece error var

Ajan asla bir directive'i **test etmek için** bir varyasyon denemiyor. "Deney" kavramı yok.
Trial-and-error'ın "trial" yarısı eksik: yalnızca kazara karşılaşılan hatalar öğreniyor.

---

## 4. Yol boyunca çıkan üç gerçek bug

### B1 — Deterministik fallback addendum'u eziyor (veri kaybı)

`optimizer.ts:148-168`:

```ts
let body = renderSkillAugmentation(normalizedRole, skill, directives, at);
if (options.llm) {
  try { ... buildSkillDistillInstruction(..., loadProjectSkillAugmentation(...)) ... }
  catch { /* fall back */ }
}
saveProjectSkillAugmentation(normalizedRole, skill, body, projectRoot);
```

`renderSkillAugmentation` **mevcut addendum'u okumuyor**; sadece o anki buffer
directive'lerini basıyor. `saveProjectSkillAugmentation` ise üzerine yazıyor
(`skill-layer.ts:96`). Yani:

- LLM yoksa → her pass'te addendum, buffer'da o an ne varsa ona indirgeniyor.
- LLM varsa ama **o skill'in** çağrısı timeout/hata alırsa → catch bloğu deterministik
  gövdeye düşüyor, ardından `saveProjectAgentConsolidated(..., prune: true)`
  (`optimizer.ts:195`) buffer'ı sıfırlıyor. Önceki pass'lerde distile edilmiş her şey
  kalıcı olarak kayboluyor; tek kalıntı `archive/`.

Bu, "6 saatte bir çalışan, hatayı yutan" bir döngüde sessizce ilerleyen bir kayıp.

**Düzeltme:** `renderSkillAugmentation`'a `existing` parametresi ver ve mevcut gövdeyi
koru — ya da fallback yolunda `saveProjectSkillAugmentation`'ı sadece append moduyla çağır.

### B2 — `no-llm` yolunda cooldown yazılmıyor

`evaluateAutoOptimize` cooldown'ı `loadConsolidationMetadata` üzerinden okuyor
(`auto-optimize.ts:121`). Ama `no-llm` dalı (`optimizer.ts:174`) metadata yazmadan dönüyor.
Yani modelsiz kurulumda her capture + 20 s debounce sonrası tam pass tekrar koşuyor; her
koşuda B1 nedeniyle addendum yeniden eziliyor. `minIntervalMs: 6h` bu yolda hiç uygulanmıyor.

### B3 — `EAGER_SKILL_LIMIT` iki yerde tanımlı

`skill-layer.ts:36` `DEFAULT_EAGER_SKILL_LIMIT = 3` ve `host-context.ts:17`
`EAGER_SKILL_LIMIT = 3`. İkisi bağımsız; biri değişirse diğeri sessizce ayrışır.
Tek kaynak olmalı (core'daki export).

---

## 5. Öneri: RL'in eksik yarısını kurmak

Prensip: **ödül, sayaçlara değil directive'lere aksın.** Aşağıdaki üç dalga bağımsız olarak
sevk edilebilir; her biri kendi başına da değer üretiyor.

### Dalga 0 — Bugları kapat (önkoşul)

B1, B2, B3. Bunlar düzelmeden altındaki hiçbir sinyal güvenilir olmaz.

### Dalga 1 — Directive-level bandit (G1, G2, G7'yi çözer)

**Şema:** `StructuredLearnedEntry`'ye üç alan ve stamp'e üç attribute:

```ts
interface StructuredLearnedEntry {
  // ...mevcut alanlar
  /** Bu directive'in enjekte edildiği ve ajanın uyguladığını bildirdiği görev sayısı. */
  applied: number;
  /** Uygulandığı ve başarıyla biten görev sayısı. */
  wins: number;
  /** Uygulandığı ve başarısız biten görev sayısı. */
  losses: number;
}
```

Stamp zaten genişletilebilir (`parseStampAttributes`, `learning-structured.ts:166` istediği
kadar `key=value` okuyor) — dosya formatı geriye dönük uyumlu kalır.

**Sinyal toplama — iki ucuz seçenek, ikisi de tek turda:**

1. *Self-report:* capture prompt'una (`identity.ts:543`) bir satır ekle —
   *"Uyguladığın project directive'lerini `## APPLIED [d3, d7]` ile bildir."* Enjeksiyon
   sırasında her entry'ye stabil kısa id ver. Ucuz ama ajanın dürüstlüğüne bağlı.
2. *Anchor eşleşmesi:* directive'in `how` alanındaki anchor'lar (komut, dosya yolu, paket adı)
   görev transcript'inde geçti mi? Geçtiyse "applied" say. Model gerektirmez, `how` zaten
   bu iş için çıkarılıyor (`extractHow`, `learning-structured.ts:123`).

Seçenek 2'yi varsayılan, 1'i takviye olarak kullanmanızı öneririm — 2 zaten elimizdeki
veriyle çalışıyor.

**Kullanım:**

- `enforceLearnedBudget` (`learning-structured.ts:376`) eviction sırasını
  `DROP_PRIORITY → capturedAt` yerine `DROP_PRIORITY → utility → capturedAt` yapsın.
  `utility = (wins + 1) / (applied + 2)`. Kanıtlanmış directive yaşından bağımsız kalsın.
- `mergeStructuredEntries` çakışmada (Jaccard ≥ 0.55) körü körüne yeniyi seçmesin:
  `applied >= 5 && utility >= 0.7` olan eski entry korunsun, yeni olan `pending` olarak
  yanına yazılsın. G7 böyle kapanır.
- Negatif öğrenme: `applied >= 8 && utility < 0.3` olan directive prompt'a
  enjekte edilmesin, `quarantine.md`'ye taşınsın. Trial-and-error'ın "error"
  yarısı ilk kez geri besleme yapmış olur.

### Dalga 2 — Skor fonksiyonunu düzelt (G3, G4, G6)

`scoreSkillAffinity` (`skill-layer.ts:337`) yerine:

```ts
export function scoreSkillAffinity(entry, now = Date.now()): number {
  if (!entry) return 0;
  if (entry.pinned) return Number.POSITIVE_INFINITY;
  const outcomes = entry.succeeded + entry.failed;
  // Laplace her durumda uygulanır: veri yoksa 0.5 (nötr prior), kötü veri bunun ALTINA iner.
  const successRate = (entry.succeeded + 1) / (outcomes + 2);
  // Yarı ömür: 30 gün. Eski kanıt nötr prior'a doğru sönümlenir.
  const ageDays = entry.lastUsedAt ? (now - Date.parse(entry.lastUsedAt)) / 864e5 : Infinity;
  const recency = Number.isFinite(ageDays) ? 0.5 ** (ageDays / 30) : 0;
  // Exploration bonusu: az denenmiş skill'e UCB payı. loaded arttıkça söner.
  const explore = 1 / Math.sqrt(1 + entry.loaded);
  return Math.log1p(entry.learned) * 2 + (successRate - 0.5) * 4 * recency + explore;
}
```

Dört değişiklik ve her birinin gerekçesi:

- `successRate - 0.5` → başarısızlık **negatif** katkı yapar; G3 kapanır.
- `Math.min(loaded,10)*0.1` gitti, yerine `1/sqrt(1+loaded)` geldi → maruz kalma ödülü değil,
  **cezası** olur; az denenmiş aday öne çıkar. G4 + G5 birlikte kapanır.
- `recency` çarpanı → eski ödül sönümlenir. G6 kapanır.
- `log1p(learned)` → tek bir "gevezelik eden" skill'in `learned` sayacıyla üst sırayı
  kalıcı olarak kilitlemesi engellenir (mevcut `learned * 2` sınırsız).

Bu tanım, sıfır geçmişte hâlâ deterministik: her aday `explore = 1` alır, tie-break curated
sıraya düşer — yeni proje davranışı bit-bit aynı kalır (mevcut sözleşme, `skill-layer.ts:332`
yorumunda korunuyor).

### Dalga 3 — Off-policy evaluation (G8, G9)

En büyük getirisi olan ama en fazla iş isteyen adım. Minimum uygulanabilir hâli:

**Holdout enjeksiyonu.** `applied` sayacı düşük olan directive'lerin %10'unu rastgele
seçilen spawn'larda prompt'tan **çıkar**, sonucu her iki kolda ayrı say. Bir directive'in
`utility(with) - utility(without)` farkı, ilk kez gerçek bir **advantage** tahmini olur —
ve bu, "self-report" gürültüsünden bağımsızdır.

Maliyeti sıfıra yakın (zaten koşan görevler), örneklem birikmesi haftalar alır ama sinyal
gerçek nedenselliktir. Bunu Dalga 1'den önce yapmayın: `applied` sayacı olmadan kolları
ayıramazsınız.

---

## 6. İyileştiğini nasıl anlarız

Şu an sistemin sağlığını ölçen tek gösterge `lifetimeCaptureCount` — yani **hacim**. Hacim
kalite değil. Dalga 1'den sonra `/agent-improve <role> status` şunları basabilir:

| Metrik | Formül | Sağlıklı yön |
|---|---|---|
| Directive isabet oranı | `Σwins / Σapplied` | ↑ |
| Ölü directive oranı | `applied === 0` olanların payı | ↓ (yazılıyor ama hiç kullanılmıyor) |
| Karantina oranı | `utility < 0.3` olanların payı | önce ↑ sonra ↓ |
| Skill rotasyonu | son 30 günde top-3'e giren farklı skill sayısı | > 3 (exploration çalışıyor) |
| Distillation sıkıştırma | `consolidatedBytes / sourceBytes` | < 1 (zaten metadata'da var) |

"Ölü directive oranı" en çok şeyi söyleyen tek sayı: yüksekse ajan doğru şeyleri öğrenmiyor
demektir ve bu, capture prompt'unun kendisinin sorunudur.

---

## 7. Uygulanan (2026-08-10)

| # | Ne | Nerede |
|---|---|---|
| B1 | Addendum ezilmesi: `renderSkillAugmentation` artık mevcut gövdeyi alıp üstüne ekliyor; yeni bir şey yoksa dosya aynen geri veriliyor (pass no-op) | `skill-layer.ts`, `optimizer.ts` |
| B2 | `lastOptimizeAt` damgası `learning.json`'a yazılıyor; cooldown `max(consolidatedAt, lastOptimizeAt)` okuyor | `learning-policy.ts`, `optimizer.ts`, `auto-optimize.ts` |
| B3 | `EAGER_SKILL_LIMIT` tek kaynak (`DEFAULT_EAGER_SKILL_LIMIT`) | `host-context.ts` |
| — | Policy yazma yarışı: capture artık stale nesne yazmıyor, patch ediyor | `learning-policy.ts`, `identity.ts` |
| D1 | `applied`/`wins` alanları + stamp serileştirme (sıfırlar yazılmıyor → eski dosyalar bit-bit aynı) | `learning-structured.ts` |
| D1 | Anchor tabanlı atıf, kazanç/kayıp katlama, karantina | `project-agent-directive-outcome.ts` (yeni) |
| D1 | Eviction sırası: kategori → utility → yaş | `learning-structured.ts` |
| D1 | Kanıtlanmış directive koruması + reword'de sicil devri (kategori eşleşmesi şartıyla) | `learning-structured.ts` |
| D1 | Sicil, hem konsolidasyon hem skill distill talimatına giriyor | `consolidation.ts`, `skill-layer.ts` |
| D1 | Atıf capture'dan **önce**; `stopped` hiç puanlanmıyor | `host-learning.ts` |
| D2 | Skor fonksiyonu: 0.5 prior, exploration bonusu, 30 günlük yarı ömür, log1p(learned) | `skill-layer.ts` |
| — | `/agent-improve <role> show` hit-rate + hiç kullanılmayan sayısı | `agent-improve.ts` |
| — | **WebUI Agent Roster / Self-Learning**: hit-rate + never-used kutucukları, rol listesinde hit-rate çipi, **Retired** bölümü, skill'lerde `loaded` rozeti + affinity skoru; `agent-roster.skills` artık `score`/`eager`/`eagerLimit` taşıyor, yeni `agent-roster.quarantine` mesajı; 2 i18n anahtarı × 7 dil | `agent-roster-handlers.ts`, `AgentRosterSelfLearningTab.tsx`, `agent-roster-data.tsx` |
| **B5** | **Emeklilik yalnızca buffer'a ulaşıyordu.** Distile edilmiş `skills/<skill>.md` ve `consolidated.md` kopyaları enjekte edilmeye devam ediyordu (bir sonraki pass 6 saate kadar uzakta). Artık emeklilikte iki belge de yerinde temizleniyor, tüm kuralları emekli olan addendum siliniyor, ve distilasyon talimatına "geri getirme" listesi veriliyor — ajanın yeniden yazdığı directive bu listeden çıkarılıyor (yeniden deneme hakkı) | `project-agent-quarantine.ts` (yeni), `directive-outcome.ts`, `consolidation.ts`, `optimizer.ts` |
| **B4** | **Spawn skill bütçesi öğrenilen addendum'u atıyordu.** 16 000 karakter dolunca tüm skill düşürülüyordu; artık **bundled body kısaltılıyor**, proje addendum'u korunuyor. Gerçek `reviewer` verisiyle ölçüldü: chimera + bug-hunter'ın 8 KB jenerik gövdesi yüzünden `testing` her spawn'da 381 karakterle taşıp düşüyordu — `affinity.json` hâlâ `"testing": {"loaded": 0}` yanında `"chimera": {"loaded": 197}` gösteriyor | `host-context.ts` |

Testler: `packages/core/tests/coordination/project-agent-directive-outcome.test.ts` (22),
`packages/cli/tests/fleet/host-learning.test.ts` (4).

Bilinçli olarak yapılmayanlar: Dalga 3 (holdout / advantage tahmini) — `applied` verisi
birikmeden kolları ayıramaz; `## APPLIED` self-report — anchor sinyali önce ölçülsün;
capture dedup semantiğinin gevşetilmesi (bkz. G7 düzeltmesi).

---

## 8. Özet

Sistem, RL'in **altyapısını** doğru kurmuş: kapalı döngü, bounded replay buffer, negatif
trajectory toplama, deterministik degradation, stampede koruması. Bunlar zor kısımdı ve
yerinde.

Eksik olan, RL'i RL yapan şey: **çevrenin verdiği ödülün, öğrenilen içeriğin kaderini
belirlemesi.** Şu an ödül `affinity.json`'da bir kenarda duruyor, öğrenilen directive'ler ise
ondan tamamen bağımsız yaşıyor ve ölüyor. Bu yüzden mevcut hâl trial-and-error değil,
ajanın kendi çıkarımlarının filtrelenmemiş birikimi.

Tek cümlelik öncelik: **`StructuredLearnedEntry`'ye `applied/wins` ekleyin ve eviction ile
çakışma çözümünü bu sayılara bağlayın.** Diğer her şey bunun üzerine kurulabilir; bu olmadan
hiçbiri kurulamaz. — *Yapıldı; §7.*

Sıradaki adım artık analiz değil ölçüm: birkaç hafta gerçek görev sonrası `/agent-improve
<role> show`'daki **hiç kullanılmayan directive oranı**na bakılmalı. Yüksekse sorun döngüde
değil, ajanların ne yazdığında — ve çözümü capture prompt'u, bu makine değil.
