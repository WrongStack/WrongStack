/** Curated bilingual intent aliases for bundled skills. Scores are priorities, not probabilities. */
export interface LocalSkillRule {
  name: string;
  domain: string;
  match: RegExp;
  priority: number;
}
export const LOCAL_SKILL_RULES: readonly LocalSkillRule[] = [
  {
    name: 'algorithmic-art',
    domain: 'media',
    match:
      /\b(?:algorithmic art|generative art|p5\.js|fractal art|algoritmik sanat|uretimsel sanat)\b/i,
    priority: 100,
  },
  {
    name: 'brand-guidelines',
    domain: 'frontend',
    match: /\b(?:brand guidelines|brand-guidelines|brand identity|marka kimligi|marka kilavuzu)\b/i,
    priority: 100,
  },
  {
    name: 'canvas-design',
    domain: 'media',
    match: /\b(?:canvas design|canvas-design|poster|afis|static artwork|print design)\b/i,
    priority: 100,
  },
  {
    name: 'discernment-nudge',
    domain: 'quality',
    match:
      /\b(?:discernment|epistemic|assumption checks?|critical assumptions|varsayim denetimi)\b/i,
    priority: 100,
  },
  {
    name: 'doc-coauthoring',
    domain: 'workflow',
    match:
      /\b(?:doc-coauthoring|coauthor(?:ing|ed)?|co-author(?:ing|ed)?|document collaboration|ortak belge)\b/i,
    priority: 95,
  },
  {
    name: 'docx',
    domain: 'media',
    match: /\b(?:docx|word document|word report|word belgesi|word raporu)\b/i,
    priority: 100,
  },
  {
    name: 'internal-comms',
    domain: 'workflow',
    match:
      /\b(?:internal-comms|internal communications|stakeholder update|ic iletisim|paydas guncellemesi)\b/i,
    priority: 100,
  },
  {
    name: 'llm-runtime',
    domain: 'integration',
    match:
      /\b(?:llm-runtime|llm runtime|ai agent runtime|streaming sse endpoint|prompt caching|tool.calling loop|llm calisma zamani)\b/i,
    priority: 100,
  },
  {
    name: 'micro-animation-gif',
    domain: 'media',
    match:
      /\b(?:micro-animation-gif|animated gif|gif animation|animated emoji|animasyonlu gif|hareketli gif)\b/i,
    priority: 100,
  },
  {
    name: 'pdf',
    domain: 'media',
    match: /\b(?:pdf|portable document format)\b/i,
    priority: 100,
  },
  {
    name: 'pptx',
    domain: 'media',
    match: /\b(?:pptx|powerpoint|presentation deck|sunum)\b/i,
    priority: 100,
  },
  {
    name: 'theme-factory',
    domain: 'frontend',
    match: /\b(?:theme-factory|theme factory|theme pack|tema paketi|tema seti)\b/i,
    priority: 100,
  },
  {
    name: 'web-artifacts',
    domain: 'frontend',
    match:
      /\b(?:web-artifacts|web artifacts?|html artifact|interactive artifact|interaktif artifact)\b/i,
    priority: 100,
  },
  {
    name: 'webapp-testing',
    domain: 'quality',
    match:
      /\b(?:webapp-testing|webapp testing|browser e2e|playwright ui|tarayici[^\n]{0,60}test)\b/i,
    priority: 100,
  },
  {
    name: 'xlsx',
    domain: 'media',
    match: /\b(?:xlsx|excel|spreadsheet|hesap tablosu)\b/i,
    priority: 100,
  },
  {
    name: 'nextjs-modern',
    domain: 'frontend',
    match: /\b(?:next(?:[ .-]?js)|next\s+\d+|app router|server action|revalidatetag|updatetag)\b/i,
    priority: 100,
  },
  {
    name: 'react-modern',
    domain: 'frontend',
    match: /\b(?:react|useeffect|usestate|useactionstate|react hook)\b/i,
    priority: 65,
  },
  {
    name: 'typescript-strict',
    domain: 'frontend',
    match: /\b(?:typescript|type narrowing|tip guven|tip daralt|\bany\b)\b/i,
    priority: 90,
  },
  {
    name: 'node-modern',
    domain: 'frontend',
    match: /\b(?:node[ .-]?js|node runtime|esm|abortsignal|abortcontroller|event loop)\b/i,
    priority: 65,
  },
  {
    name: 'astro-modern',
    domain: 'frontend',
    match: /\b(?:astro|islands architecture)\b/i,
    priority: 90,
  },
  { name: 'vue-nuxt', domain: 'frontend', match: /\b(?:vue|nuxt|composable)\b/i, priority: 90 },
  {
    name: 'sveltekit-modern',
    domain: 'frontend',
    match: /\b(?:svelte|sveltekit|runes)\b/i,
    priority: 90,
  },
  {
    name: 'angular-modern',
    domain: 'frontend',
    match: /\b(?:angular|standalone component|reactive form)\b/i,
    priority: 90,
  },
  {
    name: 'web-performance',
    domain: 'frontend',
    match:
      /\b(?:core web vitals|lighthouse|web performance|browser performance|sayfa hiz|web performans)\b/i,
    priority: 90,
  },
  {
    name: 'web-platform-baseline',
    domain: 'frontend',
    match: /\b(?:browser compat|tarayici uyum|css support|html semantics|web platform)\b/i,
    priority: 90,
  },
  {
    name: 'api-design',
    domain: 'backend',
    match:
      /\b(?:api design|rest endpoints|http contract|api tasar|endpoint tasar|openapi|pagination contract)\b/i,
    priority: 90,
  },
  {
    name: 'node-backend',
    domain: 'backend',
    match: /\b(?:fastify|express|node (?:http|api|server|service)|node backend)\b/i,
    priority: 100,
  },
  {
    name: 'python-backend',
    domain: 'backend',
    match: /\b(?:fastapi|django|flask|python api|python backend|pydantic)\b/i,
    priority: 90,
  },
  {
    name: 'go-services',
    domain: 'backend',
    match: /\b(?:golang|go (?:http|service|handler|servis)|go dili)\b/i,
    priority: 90,
  },
  { name: 'rust-systems', domain: 'backend', match: /\b(?:rust|tokio|cargo)\b/i, priority: 90 },
  {
    name: 'dotnet-backend',
    domain: 'backend',
    match: /\b(?:asp\.?net|dotnet|\.net|c#|csharp)\b/i,
    priority: 90,
  },
  {
    name: 'java-spring',
    domain: 'backend',
    match: /\b(?:spring boot|spring (?:framework|security|mvc|data)|java api|java backend|jvm)\b/i,
    priority: 90,
  },
  { name: 'php-laravel', domain: 'backend', match: /\b(?:laravel|php|eloquent)\b/i, priority: 90 },
  {
    name: 'graphql-development',
    domain: 'backend',
    match: /\b(?:graphql|resolver)\b/i,
    priority: 90,
  },
  {
    name: 'authentication-sessions',
    domain: 'backend',
    match:
      /\b(?:authentication|login flow|session rotation|session revocation|oturum|giris akis|secure cookie)\b/i,
    priority: 90,
  },
  {
    name: 'payments-webhooks',
    domain: 'backend',
    match: /\b(?:payment|payments|stripe|odeme|signed webhook|imzali webhook)\b/i,
    priority: 90,
  },
  {
    name: 'design-craft',
    domain: 'design',
    match:
      /\b(?:restyle|landing page|visual design|gorsel tasar|ui design|arayuz tasar|hero bolg|product interface)\b/i,
    priority: 65,
  },
  {
    name: 'design-critique',
    domain: 'design',
    match:
      /\b(?:design critique|critique [^\n]{0,120}(?:ui|interface|dashboard)|tasarim elestir|arayuz[^\n]{0,120}(?:elestir|degerlendir))\b/i,
    priority: 110,
  },
  {
    name: 'design-system',
    domain: 'design',
    match:
      /\b(?:design system|design token|oklch|typography token|tasarim sistem|tema token|renk token)\b/i,
    priority: 90,
  },
  {
    name: 'design-to-code',
    domain: 'design',
    match: /\b(?:figma|design to code|tasarimi koda|screenshot[^\n]{0,120}(?:implement|uygula))\b/i,
    priority: 110,
  },
  {
    name: 'interaction-design',
    domain: 'design',
    match:
      /\b(?:user journey|onboarding|interaction flow|multi.step checkout|checkout states|klavye odag\w*|etkilesim akis|kullanici yolcul|recovery states|kurtarma durum)\b/i,
    priority: 110,
  },
  {
    name: 'design-assets',
    domain: 'design',
    match: /\b(?:svg (?:icon|ikon)\w*|icon set|ikon set|logo asset|visual asset|gorsel varlik)\b/i,
    priority: 90,
  },
  {
    name: 'accessibility',
    domain: 'design',
    match:
      /\b(?:accessibility|a11y|wcag|screen.?reader|aria|erisilebilir|ekran okuyucu|keyboard navigation|klavye gezin)\b/i,
    priority: 90,
  },
  {
    name: 'visual-regression',
    domain: 'design',
    match:
      /\b(?:visual regression|screenshot baselines?|gorsel regresyon|ekran goruntusu baseline)\b/i,
    priority: 90,
  },
  {
    name: 'i18n-localization',
    domain: 'design',
    match:
      /\b(?:i18n|localization|localisation|yerellestir|plural|rtl|translation string|ceviri metin)\b/i,
    priority: 90,
  },
  {
    name: 'media-production',
    domain: 'media',
    match: /\b(?:remotion|ffmpeg|video|subtitle|altyazi|transcod|mux|render[^\n]{0,120}clip)\b/i,
    priority: 65,
  },
  {
    name: 'motion-canvas-video',
    domain: 'media',
    match: /\b(?:motion canvas|motion-canvas|generator scene)\b/i,
    priority: 100,
  },
  {
    name: 'manim-video',
    domain: 'media',
    match: /\b(?:manim|mathtex|mathematical animation|matematik animasyon)\b/i,
    priority: 100,
  },
  {
    name: 'motion-design',
    domain: 'media',
    match:
      /\b(?:motion\/react|gsap|spring transition|scroll animation|ui animation|web animasyon|sayfa animasyon|reduced.motion)\b/i,
    priority: 90,
  },
  {
    name: 'threejs-3d',
    domain: 'media',
    match:
      /\b(?:three[ .-]?js|webgpu|webgl|shader|3d scene|3d sahne|react three fiber|tsl material)\b/i,
    priority: 90,
  },
  {
    name: 'audio-studio',
    domain: 'media',
    match:
      /\b(?:voiceover|narration|seslendirme|suno|udio|audio track|music generation|muzik uret|elevenlabs)\b/i,
    priority: 90,
  },
  {
    name: 'office-documents',
    domain: 'media',
    match:
      /\b(?:docx|xlsx|pptx|word document|excel|powerpoint|pdf|presentation deck|sunum|spreadsheet)\b/i,
    priority: 90,
  },
  {
    name: 'mobile-design',
    domain: 'mobile',
    match:
      /\b(?:mobile design|mobil tasar|safe areas?|thumb reach|virtual keyboard|sanal klavye)\b/i,
    priority: 90,
  },
  {
    name: 'react-native-expo',
    domain: 'mobile',
    match: /\b(?:react native|expo|expo router)\b/i,
    priority: 100,
  },
  {
    name: 'flutter-mobile',
    domain: 'mobile',
    match: /\b(?:flutter|dart|widget test)\b/i,
    priority: 90,
  },
  {
    name: 'swift-ios',
    domain: 'mobile',
    match: /\b(?:swiftui|swift|widgetkit|ios|apple native)\b/i,
    priority: 90,
  },
  {
    name: 'kotlin-android',
    domain: 'mobile',
    match: /\b(?:kotlin|jetpack compose|android)\b/i,
    priority: 65,
  },
  {
    name: 'mobile-performance',
    domain: 'mobile',
    match:
      /\b(?:mobile performance|mobil performans|scrolling jank|startup latency|physical phone|fiziksel telefon\w*|kaydirma takil\w*)\b/i,
    priority: 100,
  },
  {
    name: 'mobile-release',
    domain: 'mobile',
    match:
      /\b(?:app store|play store|store submission|magaza|mobile signing|mobil imzala|mobile release)\b/i,
    priority: 100,
  },
  {
    name: 'ssh-operations',
    domain: 'operations',
    match: /\b(?:ssh|scp|sftp|host key|identity file)\b/i,
    priority: 90,
  },
  {
    name: 'linux-service-ops',
    domain: 'operations',
    match: /\b(?:systemd|journalctl|linux service|linux servis|ulimit)\b/i,
    priority: 90,
  },
  {
    name: 'remote-debugging',
    domain: 'operations',
    match:
      /\b(?:remote debug|remote (?:process|service)|uzak[^\n]{0,120}(?:surec|teshis|servis)|over ssh[^\n]{0,120}diagnos)\b/i,
    priority: 100,
  },
  {
    name: 'vps-deploy',
    domain: 'operations',
    match: /\b(?:vps|bare metal|existing server|mevcut sunucu)\b/i,
    priority: 90,
  },
  {
    name: 'reverse-proxy-tls',
    domain: 'operations',
    match: /\b(?:nginx|caddy|traefik|reverse proxy|tls|certificate renewal|sertifika yenile)\b/i,
    priority: 110,
  },
  {
    name: 'docker-deploy',
    domain: 'operations',
    match: /\b(?:dockerfile|docker image|container image|container imaj|docker deploy|docker)\b/i,
    priority: 65,
  },
  {
    name: 'compose-operations',
    domain: 'operations',
    match: /\b(?:docker compose|docker-compose|named.volume|compose service)\b/i,
    priority: 100,
  },
  {
    name: 'container-debugging',
    domain: 'operations',
    match:
      /\b(?:container[^\n]{0,120}(?:fail|crash|dns|debug|cannot|hata|ulasam|teshis)|container debugging|container\w*[^\n]{0,120}(?:dns|ulasam|cozem))\b/i,
    priority: 100,
  },
  {
    name: 'container-hardening',
    domain: 'operations',
    match:
      /\b(?:container harden|container[^\n]{0,120}(?:non.root|read.only|privileg|capabilit)|root olmayan|salt okunur kok|container guven)\b/i,
    priority: 100,
  },
  {
    name: 'ci-cd',
    domain: 'operations',
    match: /\b(?:github actions|gitlab ci|ci\/cd|ci pipeline|build matrix|actions matrisi)\b/i,
    priority: 90,
  },
  {
    name: 'release-rollback',
    domain: 'operations',
    match: /\b(?:rollback|release promotion|health.gated|canary|blue.green|surum gecis)\b/i,
    priority: 90,
  },
  {
    name: 'backup-recovery',
    domain: 'operations',
    match: /\b(?:backup|restore|yedek|geri yukle|recovery objective)\b/i,
    priority: 90,
  },
  {
    name: 'kubernetes-operations',
    domain: 'operations',
    match: /\b(?:kubernetes|kubectl|k8s|helm|pod autoscal|hpa)\b/i,
    priority: 90,
  },
  {
    name: 'infrastructure-as-code',
    domain: 'operations',
    match: /\b(?:terraform|pulumi|infrastructure as code|iac|vpc|subnet)\b/i,
    priority: 90,
  },
  {
    name: 'cloud-architecture',
    domain: 'operations',
    match:
      /\b(?:cloud architecture|bulut[^\n]{0,80}mimari\w*|failure domains?|region selection|cloud application architecture|bolge sec|aws architecture|azure architecture)\b/i,
    priority: 90,
  },
  {
    name: 'cloudflare-workers',
    domain: 'operations',
    match: /\b(?:cloudflare|wrangler|durable object|workers binding)\b/i,
    priority: 90,
  },
  {
    name: 'incident-response',
    domain: 'operations',
    match:
      /\b(?:production outage|incident response|uretim kesinti\w*|hizmet kesinti\w*|olay mudahale)\b/i,
    priority: 110,
  },
  {
    name: 'database-development',
    domain: 'data',
    match:
      /\b(?:postgres(?:ql)?|mysql|sqlite|database query|explain analyze|sql query|veritabani sorgu|indeks)\b/i,
    priority: 90,
  },
  {
    name: 'database-migrations',
    domain: 'data',
    match:
      /\b(?:schema migration|database migration|backfill|expand.contract|sema gecis|sema degisik)\b/i,
    priority: 100,
  },
  {
    name: 'data-governance',
    domain: 'data',
    match: /\b(?:data governance|data retention|pii|veri sahip|saklama suresi)\b/i,
    priority: 90,
  },
  {
    name: 'queues-jobs',
    domain: 'data',
    match: /\b(?:background job|job queue|dead.letter|queue|arka plan isi|kuyruk|deduplication)\b/i,
    priority: 90,
  },
  {
    name: 'realtime-systems',
    domain: 'data',
    match: /\b(?:websocket|realtime|real.time|reconnection|live update|canli guncelle)\b/i,
    priority: 90,
  },
  {
    name: 'offline-sync',
    domain: 'data',
    match: /\b(?:offline|outbox|conflict resolution|cevrimdisi|cakisma coz)\b/i,
    priority: 90,
  },
  {
    name: 'storage-uploads',
    domain: 'data',
    match:
      /\b(?:object storage|signed (?:object )?uploads?|file upload|nesne depo|nesne yukleme|dosya yukle|s3 upload)\b/i,
    priority: 90,
  },
  {
    name: 'observability',
    domain: 'data',
    match:
      /\b(?:observability|tracing|structured logging|opentelemetry|loglama|gozlemlenebilir|metrics instrumentation)\b/i,
    priority: 90,
  },
  {
    name: 'debugging',
    domain: 'quality',
    match:
      /\b(?:debug|diagnos|crash|broken|fails|failing|hata ver|hata al|calismiyor|bozuk|takiliyor|teshis)\b/i,
    priority: 65,
  },
  {
    name: 'testing',
    domain: 'quality',
    match:
      /\b(?:unit tests?|regression tests?|integration tests?|test coverage|birim test|regresyon test|test yaz)\b/i,
    priority: 110,
  },
  {
    name: 'verify-before-done',
    domain: 'quality',
    match:
      /\b(?:verify[^\n]{0,120}(?:fix|done|completion)|prove[^\n]{0,120}works|calistigini kanitla|duzeltmeyi dogrula|tamamlandigini dogrula)\b/i,
    priority: 110,
  },
  {
    name: 'evidence-audit',
    domain: 'quality',
    match:
      /\b(?:evidence.audit|find[^\n]{0,120}real[^\n]{0,120}bug|unknown defects|gercek[^\n]{0,120}(?:bug|kusur|hata)[^\n]{0,120}bul|kanitla[^\n]{0,120}duzelt)\b/i,
    priority: 110,
  },
  {
    name: 'bug-hunter',
    domain: 'quality',
    match: /\b(?:bug.hunt|bughunt|bug.hunter|cascade agent)\b/i,
    priority: 90,
  },
  {
    name: 'code-review',
    domain: 'quality',
    match:
      /\b(?:code review|review[^\n]{0,120}(?:code|implementation|diff)|kod incele|kodu incele|look over the diff)\b/i,
    priority: 90,
  },
  {
    name: 'codex-adversarial-review',
    domain: 'quality',
    match: /\b(?:adversarial review|karsit[^\n]{0,120}incele|saldirgan[^\n]{0,120}incele)\b/i,
    priority: 110,
  },
  {
    name: 'chimera',
    domain: 'quality',
    match: /\b(?:chimera|post.session review|session guardian|oturum[^\n]{0,120}incele)\b/i,
    priority: 90,
  },
  {
    name: 'auto-review',
    domain: 'quality',
    match: /\b(?:auto.review plugin|automatic review plugin|otomatik review plugin)\b/i,
    priority: 90,
  },
  {
    name: 'code-quality',
    domain: 'quality',
    match:
      /\b(?:dead code|unused depend|knip|bundle bloat|olu kod|kullanilmayan bagim|code quality audit)\b/i,
    priority: 110,
  },
  {
    name: 'security-scanner',
    domain: 'quality',
    match:
      /\b(?:security audit|security review|trust boundar|guvenlik incele|guvenlik denet|secret scan)\b/i,
    priority: 90,
  },
  {
    name: 'codebase-navigation',
    domain: 'workflow',
    match:
      /\b(?:where[^\n]{0,120}(?:module|implementation|entry)|locate[^\n]{0,120}(?:file|module)|kod[^\n]{0,120}nerede|modul[^\n]{0,120}bul|repo[^\n]{0,120}navigat|codebase navigation)\b/i,
    priority: 90,
  },
  {
    name: 'sdd',
    domain: 'workflow',
    match: /\b(?:acceptance criteria|task graph|kabul kriter|gorev graf|sdd)\b/i,
    priority: 90,
  },
  {
    name: 'git-flow',
    domain: 'workflow',
    match: /\b(?:commit|pull request|release branch|git flow|branch[^\n]{0,120}release)\b/i,
    priority: 90,
  },
  {
    name: 'refactor-planner',
    domain: 'workflow',
    match:
      /\b(?:refactor plan|split[^\n]{0,120}module|break up[^\n]{0,120}module|modul[^\n]{0,120}ayir|yeniden duzenleme plan)\b/i,
    priority: 90,
  },
  {
    name: 'multi-agent',
    domain: 'workflow',
    match:
      /\b(?:multi.agent|parallel agents|several agents|paralel ajan|birden[^\n]{0,120}ajan|delegate|delegasyon)\b/i,
    priority: 90,
  },
  {
    name: 'output-standards',
    domain: 'workflow',
    match: /\b(?:output format|response format|cikti bicim|yanit bicim)\b/i,
    priority: 90,
  },
  {
    name: 'prompt-engineering',
    domain: 'workflow',
    match:
      /\b(?:prompt engineering|system prompt|output contract|prompt muhendis|sistem prompt)\b/i,
    priority: 90,
  },
  {
    name: 'research-web',
    domain: 'workflow',
    match:
      /\b(?:research[^\n]{0,120}(?:official|sources)|web research|authoritative sources|resmi[^\n]{0,120}kaynak[^\n]{0,120}arastir)\b/i,
    priority: 90,
  },
  {
    name: 'tech-stack',
    domain: 'workflow',
    match:
      /\b(?:latest[^\n]{0,120}version|latest stable|dependency upgrade|outdated depend|son[^\n]{0,120}surum|guncel[^\n]{0,120}surum|bagimlilik[^\n]{0,120}guncelle|npm latest)\b/i,
    priority: 110,
  },
  {
    name: 'skill-creator',
    domain: 'workflow',
    match:
      /\b(?:(?:create|write|author|build|yaz|olustur)[^\n]{0,120}skill|skill[^\n]{0,120}(?:yaz|olustur)|skill generator)\b/i,
    priority: 110,
  },
  {
    name: 'audit-log',
    domain: 'workflow',
    match:
      /\b(?:session journal|audit log|oturum[^\n]{0,120}journal|oturum[^\n]{0,120}gunluk|yesterday.s session)\b/i,
    priority: 90,
  },
  {
    name: 'mnemosyne',
    domain: 'workflow',
    match:
      /\b(?:mnemosyne|sage memory|sage hafiza|memory corpus|hafiza corpus|retrieval anchor)\b/i,
    priority: 90,
  },
  {
    name: 'mcp-development',
    domain: 'integration',
    match: /\b(?:mcp server|mcp sunucu\w*|model context protocol|fastmcp)\b/i,
    priority: 110,
  },
  {
    name: 'mailbox-bridge',
    domain: 'integration',
    match: /\b(?:external agent[^\n]{0,120}mailbox|dis ajan[^\n]{0,120}mailbox|mailbox bridge)\b/i,
    priority: 90,
  },
  {
    name: 'wrongstack-kanban',
    domain: 'integration',
    match: /\b(?:kanban|task board|gorev panosu|move[^\n]{0,120}card|karti[^\n]{0,120}tasi)\b/i,
    priority: 90,
  },
  {
    name: 'plugin-author',
    domain: 'integration',
    match: /\b(?:wrongstack plugin|plugin hook|pretooluse)\b/i,
    priority: 90,
  },
  {
    name: 'wrongstack-mailbox',
    domain: 'integration',
    match: /\b(?:roster mailbox|mailbox client protocol)\b/i,
    priority: 90,
  },
  {
    name: 'wrongstack-mailbox-mcp',
    domain: 'integration',
    match: /\b(?:mailbox mcp)\b/i,
    priority: 90,
  },
  {
    name: 'skill-router',
    domain: 'workflow',
    match:
      /\b(?:which skill|choose[^\n]{0,120}skills|skill[^\n]{0,120}oner|hangi skill|skill[^\n]{0,120}sec)\b/i,
    priority: 110,
  },
];
