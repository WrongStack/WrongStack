import remarkGfm from 'remark-gfm';
import { LazyMarkdown } from '../MessageBubble/LazyMarkdown';
import { markdownComponents, rehypePlugins } from '../MessageBubble/utils';

/** Shared surfaces render message markdown exactly as the WebUI chat does. */
export function WebuiSurfaceMarkdown({ children }: { children: string }) {
  return (
    <LazyMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      components={markdownComponents}
    >
      {children}
    </LazyMarkdown>
  );
}
