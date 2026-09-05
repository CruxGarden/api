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
  /**
   * The inline script to inject (wrapped in <script>). A function when the
   * script needs publish-time facts baked in — see the Crux Store client,
   * which cannot discover its own crux id at runtime on a direct visit.
   */
  script: string | ((ctx: InjectionContext) => string);
}

export interface InjectionContext {
  artifact: Artifact;
  allArtifacts: Artifact[];
  cruxKind?: string;
  /** The crux being published — required for store calls from a standalone page. */
  cruxId?: string;
  /** Public API origin the published page should call. */
  apiBase?: string;
}

/** JSON-encode a value for safe inlining inside a <script> block. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c');
}

/** Public origin of this API, as a published page must call it. */
function publicApiBase(): string {
  return (
    process.env.PUBLIC_API_URL ||
    process.env.API_URL ||
    'https://api.crux.garden'
  );
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

/** True when the crux is a webapp or notes vault — anything with SPA routing */
function isWebApp(ctx: InjectionContext): boolean {
  // Explicit SPA-capable kinds
  if (ctx.cruxKind === CruxKind.WEBAPP || ctx.cruxKind === CruxKind.NOTES)
    return true;
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
// With per-crux subdomain isolation, each crux is served at the root of its
// own origin ({cruxId}.publish.crux.garden). The basename is always '/'.

const SPA_BASENAME: PublishInjection = {
  id: 'spa-basename',
  shouldApply: (ctx) => isIndexHtml(ctx.artifact) && isWebApp(ctx),
  script: `(function(){
  window.__CRUX_BASENAME__='/';
})();`,
};

// ---------------------------------------------------------------------------
// Injection: SPA navigation sync
// ---------------------------------------------------------------------------
// Monkey-patches history.pushState and replaceState + listens for popstate
// to notify the parent frame (crux.garden) of route changes via postMessage.
// Works universally with any SPA framework (React Router, Vue Router, etc.)
// With per-crux subdomains, paths are already root-relative — no prefix to strip.

const SPA_NAVIGATE_SYNC: PublishInjection = {
  id: 'spa-navigate-sync',
  shouldApply: (ctx) => {
    // Inject into ALL HTML files — not just index.html.
    // Multi-page sites do full navigations between .html files.
    // Each page needs the sync script to update the parent URL.
    const p = (ctx.artifact.meta?.path || ctx.artifact.filename || '')
      .toLowerCase()
      .replace(/^\//, '');
    return (p.endsWith('.html') || p.endsWith('.htm')) && isWebApp(ctx);
  },
  script: `(function(){
  if(window.parent===window)return;
  function notify(){
    window.parent.postMessage({type:'crux:navigate',path:location.pathname},'*');
  }
  var OP=history.pushState,OR=history.replaceState;
  history.pushState=function(){OP.apply(this,arguments);notify();};
  history.replaceState=function(){OR.apply(this,arguments);notify();};
  window.addEventListener('popstate',notify);
  notify();
})();`,
};

// ---------------------------------------------------------------------------
// Injection: Crux Store client
// ---------------------------------------------------------------------------
// Exposes window.crux.store with get/set/increment/delete/list methods.
// In live mode, calls the crux.garden API. In local mode (workspace preview),
// routes all calls back to the parent via postMessage.

const CRUX_STORE_CLIENT: PublishInjection = {
  id: 'crux-store-client',
  shouldApply: (ctx) => {
    const p = (ctx.artifact.meta?.path || ctx.artifact.filename || '')
      .toLowerCase()
      .replace(/^\//, '');
    return p.endsWith('.html') || p.endsWith('.htm');
  },
  script: (ctx) => `(function(){
  window.crux=window.crux||{};
  var PUBLISHED_CRUX_ID=${inlineJson(ctx.cruxId)};
  var PUBLISHED_API_BASE=${inlineJson(ctx.apiBase)};
  // Where this page was published from, for pages that call the API beyond the
  // store (sign-in by email code, for instance).
  window.crux.publish={cruxId:PUBLISHED_CRUX_ID,apiBase:PUBLISHED_API_BASE};
  var BASE=(PUBLISHED_CRUX_ID&&PUBLISHED_API_BASE)?PUBLISHED_API_BASE+'/store/'+PUBLISHED_CRUX_ID:'';
  var _token=null,_mode='live',_cruxId=PUBLISHED_CRUX_ID;
  var _resolveReady;
  var _ready=new Promise(function(r){_resolveReady=r;});
  // A page opened directly (its own subdomain, no parent frame) never receives
  // a crux:session message, so it must be ready immediately — waiting for one
  // left every store call pending forever. Framed contexts (the workspace
  // preview) still override mode/token when their session arrives.
  if(window.parent===window&&BASE)_resolveReady();
  window.addEventListener('message',function(e){
    // Only the opener may configure the session: any page can embed a
    // published crux, and an arbitrary embedder must not be able to point
    // store traffic at a server of its choosing.
    if(e.source!==window.parent)return;
    if(e.data&&e.data.type==='crux:session'){
      _token=e.data.token||null;
      _mode=e.data.mode||'live';
      _cruxId=e.data.cruxId||_cruxId;
      var apiBase=e.data.apiBase||PUBLISHED_API_BASE||'';
      if(_cruxId)BASE=apiBase+'/store/'+_cruxId;
      _resolveReady();
    }
  });
  function hdr(){var h={'Content-Type':'application/json'};if(_token)h['Authorization']='Bearer '+_token;return h;}
  function localCall(type,payload){
    return new Promise(function(res){
      var id=Math.random().toString(36).slice(2);
      var timeout=setTimeout(function(){window.removeEventListener('message',h);res(null);},5000);
      function h(e){
        if(e.data&&e.data.id===id&&e.data.type===type+':res'){
          clearTimeout(timeout);
          window.removeEventListener('message',h);
          res(e.data.value!==undefined?e.data.value:e.data.keys||null);
        }
      }
      window.addEventListener('message',h);
      window.parent.postMessage(Object.assign({type:type,id:id},payload),'*');
    });
  }
  window.crux.store={
    get:function(key){
      return _ready.then(function(){
        if(_mode==='local')return localCall('crux:store:get',{key:key});
        return fetch(BASE+'/'+encodeURIComponent(key),{headers:hdr()}).then(function(r){return r.ok?r.json().then(function(d){return d.value}):null}).catch(function(){return null});
      });
    },
    set:function(key,value,opts){
      var m=(opts&&opts.mode)||'protected';
      return _ready.then(function(){
        if(_mode==='local'){window.parent.postMessage({type:'crux:store:set',key:key,value:value,mode:m},'*');return;}
        return fetch(BASE+'/'+encodeURIComponent(key),{method:'PUT',headers:hdr(),body:JSON.stringify({value:value,mode:m})}).then(function(r){if(!r.ok)throw new Error('Store set failed: '+r.status)});
      });
    },
    increment:function(key,by){
      if(by===undefined)by=1;
      return _ready.then(function(){
        if(_mode==='local')return localCall('crux:store:inc',{key:key,by:by});
        return fetch(BASE+'/'+encodeURIComponent(key)+'/inc',{method:'POST',headers:hdr(),body:JSON.stringify({by:by})}).then(function(r){if(!r.ok)throw new Error('Store increment failed: '+r.status);return r.json().then(function(d){return d.value})});
      });
    },
    delete:function(key){
      return _ready.then(function(){
        if(_mode==='local'){window.parent.postMessage({type:'crux:store:del',key:key},'*');return;}
        return fetch(BASE+'/'+encodeURIComponent(key),{method:'DELETE',headers:hdr()}).then(function(r){if(!r.ok)throw new Error('Store delete failed: '+r.status)});
      });
    },
    list:function(){
      return _ready.then(function(){
        if(_mode==='local')return localCall('crux:store:list',{});
        return fetch(BASE,{headers:hdr()}).then(function(r){if(!r.ok)throw new Error('Store list failed: '+r.status);return r.json()});
      });
    }
  };
  if(window.parent!==window)window.parent.postMessage({type:'crux:ready'},'*');
})();`,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const PUBLISH_INJECTIONS: PublishInjection[] = [
  SPA_INDEX_STRIP,
  SPA_BASENAME,
  SPA_NAVIGATE_SYNC,
  CRUX_STORE_CLIENT,
];

/**
 * Apply all matching injections to an HTML file's content.
 */
export function applyInjections(
  content: Buffer,
  artifact: Artifact,
  allArtifacts: Artifact[],
  cruxKind?: string,
  options?: { cruxId?: string; apiBase?: string },
): { data: Buffer; applied: string[] } {
  const ctx: InjectionContext = {
    artifact,
    allArtifacts,
    cruxKind,
    cruxId: options?.cruxId,
    apiBase: options?.apiBase ?? publicApiBase(),
  };
  const matching = PUBLISH_INJECTIONS.filter((inj) => inj.shouldApply(ctx));

  if (matching.length === 0) {
    return { data: content, applied: [] };
  }

  let html = content.toString('utf-8');
  const combined = matching
    .map((inj) =>
      typeof inj.script === 'function' ? inj.script(ctx) : inj.script,
    )
    .join('\n');
  const tag = `<script data-crux-inject>${combined}</script>`;

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
