import Artifact from '../../artifact/entities/artifact.entity';
import { CruxKind } from '../types/enums';

/**
 * Publish injections are small scripts injected into HTML files during
 * the publish-to-static-bucket step. Each injection targets a specific
 * concern and can be independently enabled/disabled.
 *
 * To add a new injection:
 *   1. Define the script string
 *   2. Create a PublishInjection entry with shouldApply + script
 *   3. Add it to the INJECTIONS array
 */

export interface PublishInjection {
  /** Unique identifier for logging */
  id: string;
  /** When should this injection be applied? */
  shouldApply: (ctx: InjectionContext) => boolean;
  /** The inline script to inject (will be wrapped in <script>) */
  script: string;
}

export interface InjectionContext {
  artifact: Artifact;
  allArtifacts: Artifact[];
  cruxKind?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the artifact is the root index.html entry point */
function isIndexHtml(artifact: Artifact): boolean {
  const p = (artifact.meta?.path || artifact.filename || '')
    .toLowerCase()
    .replace(/^\//, '');
  return p === 'index.html';
}

/** True when the crux is a webapp — either explicitly set or auto-detected */
function isWebApp(ctx: InjectionContext): boolean {
  // Explicit kind takes priority
  if (ctx.cruxKind === CruxKind.WEBAPP) return true;
  if (ctx.cruxKind && ctx.cruxKind !== CruxKind.WEBAPP) return false;

  // Auto-detect: any crux with an index.html is treated as a web app
  return ctx.allArtifacts.some((a) => isIndexHtml(a));
}

// ---------------------------------------------------------------------------
// Injection: SPA index.html strip
// ---------------------------------------------------------------------------
// CloudFront rewrites deep links to /{authorId}/{cruxId}/index.html, but the
// browser URL then shows /index.html. This strips it so routers see "/".

const SPA_INDEX_STRIP: PublishInjection = {
  id: 'spa-index-strip',
  shouldApply: (ctx) => isIndexHtml(ctx.artifact) && isWebApp(ctx),
  script: `(function(){
  if(location.pathname.endsWith('/index.html')){
    history.replaceState(null,'',location.pathname.replace(/\\/index\\.html$/,'/'));
  }
})();`,
};

// ---------------------------------------------------------------------------
// Injection: SPA basename detection
// ---------------------------------------------------------------------------
// Published SPAs live at /{authorId}/{cruxId}/. Frameworks with client-side
// routing need to know this prefix. We expose it as window.__CRUX_BASENAME__
// so any framework can pick it up.

const SPA_BASENAME: PublishInjection = {
  id: 'spa-basename',
  shouldApply: (ctx) => isIndexHtml(ctx.artifact) && isWebApp(ctx),
  script: `(function(){
  var p=location.pathname.split('/').filter(Boolean);
  window.__CRUX_BASENAME__=p.length>=2?'/'+p[0]+'/'+p[1]:'/';
})();`,
};

// ---------------------------------------------------------------------------
// Injection: SPA navigation sync
// ---------------------------------------------------------------------------
// Monkey-patches history.pushState and replaceState + listens for popstate
// to notify the parent frame (crux.garden) of route changes via postMessage.
// Works universally with any SPA framework (React Router, Vue Router, etc.)

const SPA_NAVIGATE_SYNC: PublishInjection = {
  id: 'spa-navigate-sync',
  shouldApply: (ctx) => isIndexHtml(ctx.artifact) && isWebApp(ctx),
  script: `(function(){
  if(window.parent===window)return;
  var p=location.pathname.split('/').filter(Boolean);
  var base=p.length>=2?'/'+p[0]+'/'+p[1]:'';
  function notify(){
    var path=location.pathname;
    if(base&&path.indexOf(base)===0)path=path.slice(base.length)||'/';
    window.parent.postMessage({type:'crux:navigate',path:path},'*');
  }
  var OP=history.pushState,OR=history.replaceState;
  history.pushState=function(){OP.apply(this,arguments);notify();};
  history.replaceState=function(){OR.apply(this,arguments);notify();};
  window.addEventListener('popstate',notify);
  notify();
})();`,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PUBLISH_INJECTIONS: PublishInjection[] = [
  SPA_INDEX_STRIP,
  SPA_BASENAME,
  SPA_NAVIGATE_SYNC,
];

/**
 * Apply all matching injections to an HTML file's content.
 * Injects scripts as a single <script> block before </head>.
 */
export function applyInjections(
  content: Buffer,
  artifact: Artifact,
  allArtifacts: Artifact[],
  cruxKind?: string,
): { data: Buffer; applied: string[] } {
  const ctx: InjectionContext = { artifact, allArtifacts, cruxKind };
  const matching = PUBLISH_INJECTIONS.filter((inj) => inj.shouldApply(ctx));

  if (matching.length === 0) {
    return { data: content, applied: [] };
  }

  const combined = matching.map((inj) => inj.script).join('\n');
  const tag = `<script data-crux-inject>${combined}</script>`;

  let html = content.toString('utf-8');

  // Inject before </head> if present, otherwise before </body>, otherwise append
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${tag}\n</head>`);
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', `${tag}\n</body>`);
  } else {
    html += `\n${tag}`;
  }

  return {
    data: Buffer.from(html, 'utf-8'),
    applied: matching.map((inj) => inj.id),
  };
}
