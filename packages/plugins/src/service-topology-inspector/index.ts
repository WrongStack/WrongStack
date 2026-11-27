import { cycles } from '../workflow-runtime/graph.js';
import { localRequest, localUrl } from '../workflow-runtime/http.js';
import { rows, str, strings, workflowPlugin } from '../workflow-runtime/index.js';
export default workflowPlugin({
  name: 'service-topology-inspector',
  description:
    'Probes declared loopback service health endpoints, maps dependency failures and reports missing services and topology cycles',
  tools: [
    {
      name: 'service_topology_inspect',
      mutating: true,
      capabilities: ['net.outbound'],
      description:
        'Supply services [{name,url,dependsOn?}]. Probe each health URL once and return unhealthy dependencies and cycles. Does not start or stop services.',
      properties: {
        services: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'object' },
          description:
            'Services {name, url, dependsOn?}: url is a loopback health endpoint; dependsOn lists other service names.',
        },
      },
      required: ['services'],
      async run(input, context) {
        const services = rows(input.services).map((item) => ({
          name: str(item.name),
          url: localUrl(item.url),
          dependencies: item.dependsOn === undefined ? [] : strings(item.dependsOn),
        }));
        if (!services.length || services.length > 50) throw new Error('Provide 1..50 services');
        if (new Set(services.map((service) => service.name)).size !== services.length)
          throw new Error('Duplicate service names');
        const results = await Promise.all(
          services.map(async (service) => {
            try {
              const response = await localRequest(service.url, {}, context.signal);
              return {
                name: service.name,
                healthy: response.status >= 200 && response.status < 300,
                status: response.status,
                error: null,
              };
            } catch (error) {
              context.signal.throwIfAborted();
              return { name: service.name, healthy: false, status: null, error: String(error) };
            }
          }),
        );
        const dependencies = new Map(
          services.map((service) => [service.name, service.dependencies]),
        );
        return {
          services: results.map((result) => ({
            ...result,
            blockedBy: dependencies
              .get(result.name)!
              .filter(
                (dependency) =>
                  !results.some((candidate) => candidate.name === dependency && candidate.healthy),
              ),
          })),
          cycles: cycles(dependencies),
          missing: [
            ...new Set(
              services
                .flatMap((service) => service.dependencies)
                .filter((name) => !dependencies.has(name)),
            ),
          ],
        };
      },
    },
  ],
});
