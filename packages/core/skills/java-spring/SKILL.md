---
name: java-spring
description: "Spring Boot and Java services: controllers, Spring Data JPA, @Transactional, Spring Security, Jackson, virtual threads, Maven/Gradle. Use when adding or fixing Spring endpoints, JPA queries, transactions, scheduled or async work, or upgrading the JDK, Spring Boot 3 to 4, or the build wrapper. Not for HTTP contract design (use api-design) or broker delivery semantics (use queues-jobs)."
trigger: "Use when a change touches application.yml/properties, pom.xml or build.gradle, Spring beans, JPA entities or repositories, or a JDK or Spring Boot upgrade."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
paths: ["application.{properties,yml,yaml}", "application-*.{properties,yml,yaml}"]
---

# Java Spring

## Selection card
- Task: Implement or repair Spring Boot APIs, JPA persistence, transactions and background work.
- Start: Read the build file and wrapper (`mvnw` or `gradlew`), the Boot parent or BOM version, application.yml, and the controller-service-repository path being changed.
- Finish: the wrapper's verify/check task passes, the packaged jar starts, `/actuator/health` and the changed route answer, and shutdown is graceful.

## Overview

Spring bugs hide behind proxies and defaults: `@Transactional` that never applies, lazy loads firing during JSON rendering, and pools starved by HTTP calls inside transactions. Defaults also change between Boot majors.
Checked 2026-11-02: JDK 27 GA and Spring Boot 4.1.2 stable. Spring Boot 4.2.0-RC1 and JDK 28 are previews/early access. Gradle current release is 9.8.2; verify its JDK/plugin matrix.
JDK 25 is the current LTS and JDK 27 a short-lived feature release; target the JDK the deployment image actually runs.

## Rules

1. `@Transactional` applies only through the Spring proxy: self-invocation (`this.save()`) and private methods bypass it, and checked exceptions commit unless `rollbackFor` says otherwise. Prove rollback with a test, not by reading the annotation.
2. No remote I/O inside a transaction. HTTP, RPC or broker calls in `@Transactional` hold a Hikari connection for their whole duration; do them before or after, and publish side effects with `@TransactionalEventListener(phase = AFTER_COMMIT)` or an outbox table.
3. Never serialize `@Entity` objects. Map to `record` DTOs or interface projections inside the service and set `spring.jpa.open-in-view=false`, so lazy access outside a transaction fails loudly instead of querying during rendering.
4. Constructor injection with `final` fields; singleton beans hold no per-request or per-user mutable state.
5. Validate with `@Valid`/`@Validated` at the boundary and authorize both route and object: a `SecurityFilterChain` rule proves a role, not that the caller owns the row. Method security needs `@EnableMethodSecurity`.
6. Every outbound client gets connect and read timeouts (`RestClient`, `WebClient`, JDBC driver and Hikari `connectionTimeout`); an unbounded wait becomes pool exhaustion.
7. With `spring.threads.virtual.enabled=true`, concurrency is bounded by pools, not threads: size Hikari and downstream limits explicitly and do not cache heavy objects in `ThreadLocal`.
8. Keep the wrapper, Boot BOM and JDK target; let the BOM manage versions. A Boot, Hibernate or JDK major is its own change.

## First moves by situation

| Situation | First moves |
|---|---|
| New endpoint | Copy a sibling controller's DTOs, `@RestControllerAdvice` returning `ProblemDetail`, and security rules; write the `@WebMvcTest` slice first |
| `LazyInitializationException` or N+1 | Fetch in the service with `@EntityGraph`, `JOIN FETCH` or a DTO projection; log SQL or Hibernate statistics to count queries per request |
| Rollback did not happen | Look for self-invocation, private or final methods, a swallowed exception, a checked exception, or the wrong `TransactionManager` with multiple datasources |
| `SQLTransientConnectionException` (pool timeout) | Long transactions, remote calls inside them, pool size versus virtual-thread concurrency; set Hikari `leakDetectionThreshold` to find leaks |
| Boot 3 to 4 upgrade | Move to the latest 3.5.x and clear deprecations first. Boot 4 renames starters (`spring-boot-starter-web` becomes `spring-boot-starter-webmvc`), splits test starters per technology, ships Jackson 3 (`tools.jackson` packages; annotations stay in `com.fasterxml.jackson.annotation`), and replaces `@MockBean` with `@MockitoBean`. Add `spring-boot-properties-migrator` temporarily to log renamed properties |
| JDK upgrade | Check Gradle's JDK compatibility, Mockito/ByteBuddy agents, Lombok and annotation processors before the bump; set `maven.compiler.release` or the Gradle toolchain explicitly |
| Duplicate scheduled runs | `@Scheduled` fires on every instance; add a distributed lock (ShedLock or a DB row lock) or move it to a queue |
| Security review | Filter chain order, CSRF disabled only for stateless token APIs, actuator exposure limited, `@PreAuthorize` checks ownership, secrets absent from `application*.yml` |

## Patterns and pitfalls

- **Writes in AFTER_COMMIT listeners** — the original transaction has already committed; data access there still joins it but is never committed. Annotate the listener `@Transactional(propagation = Propagation.REQUIRES_NEW)`.
- **Fetch join plus paging** — `JOIN FETCH` on a collection with a `Pageable` makes Hibernate paginate in memory (it logs a warning). Set `hibernate.query.fail_on_pagination_over_collection_fetch=true`, then page IDs first and fetch the graph second.
- **IDENTITY disables batching** — `GenerationType.IDENTITY` prevents JDBC batch inserts; bulk-insert paths need a sequence with a pooled optimizer and `hibernate.jdbc.batch_size`.
- **Entity equality** — Lombok `@Data` or `@EqualsAndHashCode` on entities hashes lazy collections (loading them) and recurses through bidirectional links; use an id-based or business-key `equals` that is stable across persist.
- **readOnly transactions** — `@Transactional(readOnly = true)` switches Hibernate to manual flush, so modified managed entities are silently not written; it may also route to a replica through a routing datasource.
- **Scheduler and async defaults** — `@Scheduled` uses a single-thread scheduler unless `spring.task.scheduling.pool.size` is raised, so one slow job delays all; `@Async` obeys the same proxy rules as `@Transactional`.
- **Virtual-thread pinning** — on JDK 24+ (JEP 491) `synchronized` no longer pins carrier threads; native and FFM frames still do. On JDK 21, blocking I/O inside `synchronized` still pins, so check the runtime JDK before rewriting locks.
- **Jackson 3 behavior** — beyond the package move, several serialization defaults changed; snapshot representative JSON responses before the upgrade and diff them after.
- **Shutdown budget** — confirm `server.shutdown=graceful` (recent Boot versions default to it) and keep `spring.lifecycle.timeout-per-shutdown-phase` inside the container's termination grace period.
- **Actuator exposure** — only `health` is exposed over HTTP by default; adding `env`, `heapdump` or `configprops` to `management.endpoints.web.exposure.include` without auth leaks secrets.
- **Test fidelity** — H2 standing in for PostgreSQL hides dialect, locking and constraint bugs; use Testcontainers with `@ServiceConnection` (Boot 3.1+).
- **Security config drift** — Spring Security 7 (with Boot 4) removes long-deprecated configuration styles; check its migration guide before copying older `SecurityFilterChain` snippets.

## Workflow

1. `java -version` plus `./mvnw -v` or `./gradlew --version`; read the Boot version, BOM imports, toolchain and the Dockerfile's base JDK.
2. Trace controller → service (transaction boundary) → repository → entity; note security config and exception advice.
3. Write the failing test first: `@WebMvcTest` for web contracts, `@DataJpaTest` with Testcontainers for queries, `@SpringBootTest` only for cross-cutting flows.
4. Implement with DTOs, explicit fetch plans and transactions that contain only database work.
5. Schema changes go through the project's Flyway or Liquibase migrations; read the SQL before applying.
6. Run the proof, start the packaged jar and exercise the changed route and shutdown.

## Proof

Prefer the project's wrapper tasks and CI workflow. Common defaults:

- Maven: `./mvnw -B verify`; inspect versions with `./mvnw dependency:tree -Dincludes=tools.jackson.core`
- Gradle: `./gradlew check`; inspect with `./gradlew dependencyInsight --dependency jackson-databind --configuration runtimeClasspath`
- Formatting where configured: `./mvnw spotless:check` or `./gradlew spotlessCheck`
- Rollback proof: an integration test that throws mid-service and asserts the row count is unchanged
- Smoke: `java -jar target/app.jar` (or `build/libs/`), `curl -fsS localhost:8080/actuator/health`, hit the changed route, then `kill -TERM <pid>` and look for "Graceful shutdown complete" in the log

## Stop and ask

- The change moves Spring Boot, Hibernate or JDK major versions, or adopts native image, WebFlux or virtual threads.
- A Flyway or Liquibase migration drops, renames or rewrites data, or targets a shared database.
- It edits the global `SecurityFilterChain`, CSRF policy or actuator exposure.
- Proof needs production credentials, a cloud config server or a broker you cannot run locally.

## Before returning

- [ ] JDK, wrapper and Boot BOM versions intended; no hand-pinned versions fighting the BOM
- [ ] Transactions contain only database work; rollback behavior proven by a test
- [ ] Controllers return DTOs; open-in-view off or its use justified; query count checked
- [ ] Validation and object-level authorization enforced on the changed routes
- [ ] Outbound clients have timeouts; pool sizing reviewed if virtual threads are on
- [ ] `verify`/`check` passes; packaged jar started, health and changed route answered, graceful shutdown observed

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[JDK releases](https://jdk.java.net/), [Spring requirements](https://docs.spring.io/spring-boot/system-requirements.html), [Spring Boot wiki release notes](https://github.com/spring-projects/spring-boot/wiki), [Spring transactions](https://docs.spring.io/spring-framework/reference/data-access/transaction.html).

## Skills in scope

- api-design — `@RestController` contracts, `ProblemDetail` (RFC 9457) handling and pagination.
- database-development — JPA queries, isolation, locking and bounded results.
- database-migrations — Flyway or Liquibase changes that deploy without downtime.
- queues-jobs — Kafka, RabbitMQ or scheduled consumers with delivery, retry and shutdown semantics.
- authentication-sessions — Spring Security login, sessions, tokens and tenant authorization.
- testing — `@WebMvcTest`, `@DataJpaTest`, Testcontainers and rollback verification.
