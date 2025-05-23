import type { LoaderTree } from '../../server/lib/app-dir-module'
import { AppPageRouteModule } from '../../server/route-modules/app-page/module.compiled' with { 'turbopack-transition': 'next-ssr' }
import { RouteKind } from '../../server/route-kind' with { 'turbopack-transition': 'next-server-utility' }
import type { IncomingMessage, ServerResponse } from 'webpack-dev-server'
import { getRevalidateReason } from '../../server/instrumentation/utils'
import { getTracer, type Span } from '../../server/lib/trace/tracer'
import { getRequestMeta } from '../../server/request-meta'
import { BaseServerSpan } from '../../server/lib/trace/constants'
import { SpanKind } from '@opentelemetry/api'
import {
  RouterServerContextSymbol,
  routerServerGlobal,
} from '../../server/lib/router-utils/router-server-context'
import { interopDefault } from '../../server/app-render/interop-default'
import { NodeNextRequest, NodeNextResponse } from '../../server/base-http/node'
import { checkIsAppPPREnabled } from '../../server/lib/experimental/ppr'
import { getFallbackRouteParams } from '../../server/request/fallback-params'
import { setReferenceManifestsSingleton } from '../../server/app-render/encryption-utils'
import { createServerModuleMap } from '../../server/app-render/action-utils'
import { RSC_HEADER } from '../../client/components/app-router-headers'

// These are injected by the loader afterwards.

/**
 * The tree created in next-app-loader that holds component segments and modules
 * and I've updated it.
 */
declare const tree: LoaderTree
declare const pages: any

// We inject the tree and pages here so that we can use them in the route
// module.
// INJECT:tree
// INJECT:pages

export { tree, pages }

import GlobalError from 'VAR_MODULE_GLOBAL_ERROR' with { 'turbopack-transition': 'next-server-utility' }

export { GlobalError }

// These are injected by the loader afterwards.
declare const __next_app_require__: (id: string | number) => unknown
declare const __next_app_load_chunk__: (id: string | number) => Promise<unknown>

// INJECT:__next_app_require__
// INJECT:__next_app_load_chunk__

export const __next_app__ = {
  require: __next_app_require__,
  loadChunk: __next_app_load_chunk__,
}

import * as entryBase from '../../server/app-render/entry-base' with { 'turbopack-transition': 'next-server-utility' }

export * from '../../server/app-render/entry-base' with { 'turbopack-transition': 'next-server-utility' }

// Create and export the route module that will be consumed.
export const routeModule = new AppPageRouteModule({
  definition: {
    kind: RouteKind.APP_PAGE,
    page: 'VAR_DEFINITION_PAGE',
    pathname: 'VAR_DEFINITION_PATHNAME',
    // The following aren't used in production.
    bundlePath: '',
    filename: '',
    appPaths: [],
  },
  userland: {
    loaderTree: tree,
  },
  distDir: process.env.__NEXT_RELATIVE_DIST_DIR || '',
  projectDir: process.env.__NEXT_RELATIVE_PROJECT_DIR || '',
})

export async function handler(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    waitUntil: (prom: Promise<void>) => void
  }
) {
  let srcPage = 'VAR_DEFINITION_PAGE'

  // turbopack doesn't normalize `/index` in the page name
  // so we need to to process dynamic routes properly
  // TODO: fix turbopack providing differing value from webpack
  if (process.env.TURBOPACK) {
    srcPage = srcPage.replace(/\/index$/, '') || '/'
  } else if (srcPage === '/index') {
    // we always normalize /index specifically
    srcPage = '/'
  }
  const multiZoneDraftMode = process.env
    .__NEXT_MULTI_ZONE_DRAFT_MODE as any as boolean

  const prepareResult = await routeModule.prepare(req, res, {
    srcPage,
    multiZoneDraftMode,
  })

  if (!prepareResult) {
    res.statusCode = 400
    res.end('Bad Request')
    ctx.waitUntil?.(Promise.resolve())
    return null
  }

  const {
    buildId,
    query,
    params,
    parsedUrl,
    buildManifest,
    nextFontManifest,
    serverFilesManifest,
    reactLoadableManifest,
    serverActionsManifest,
    clientReferenceManifest,
    subresourceIntegrityManifest,
    prerenderManifest,
    isDraftMode,
    isOnDemandRevalidate,
  } = prepareResult

  const routerServerContext =
    routerServerGlobal[RouterServerContextSymbol]?.[
      process.env.__NEXT_RELATIVE_PROJECT_DIR || ''
    ]

  const onError = routeModule.instrumentationOnRequestError.bind(routeModule)
  const nextConfig =
    routerServerContext?.nextConfig || serverFilesManifest.config

  const pathname = parsedUrl.pathname || '/'
  const isIsr = Boolean(
    prerenderManifest.dynamicRoutes[srcPage] ||
      prerenderManifest.routes[srcPage] ||
      prerenderManifest.routes[pathname]
  )

  // const isIsrFallback = Boolean(getRequestMeta(req, 'isIsrFallback'))
  const couldSupportPPR: boolean = checkIsAppPPREnabled(
    nextConfig.experimental.ppr
  )

  // When enabled, this will allow the use of the `?__nextppronly` query to
  // enable debugging of the static shell.
  const hasDebugStaticShellQuery =
    process.env.__NEXT_EXPERIMENTAL_STATIC_SHELL_DEBUGGING === '1' &&
    typeof query.__nextppronly !== 'undefined' &&
    couldSupportPPR

  // When enabled, this will allow the use of the `?__nextppronly` query
  // to enable debugging of the fallback shell.
  const hasDebugFallbackShellQuery =
    hasDebugStaticShellQuery && query.__nextppronly === 'fallback'

  // This page supports PPR if it is marked as being `PARTIALLY_STATIC` in the
  // prerender manifest and this is an app page.
  const isRoutePPREnabled = Boolean(
    couldSupportPPR &&
      ((
        prerenderManifest.routes[pathname] ??
        prerenderManifest.dynamicRoutes[srcPage]
      )?.renderingMode === 'PARTIALLY_STATIC' ||
        // Ideally we'd want to check the appConfig to see if this page has PPR
        // enabled or not, but that would require plumbing the appConfig through
        // to the server during development. We assume that the page supports it
        // but only during development.
        (hasDebugStaticShellQuery &&
          (routeModule.isDev || routerServerContext?.experimentalTestProxy)))
  )

  const isDebugFallbackShell = hasDebugFallbackShellQuery && isRoutePPREnabled

  const isDebugStaticShell: boolean =
    hasDebugStaticShellQuery && isRoutePPREnabled

  // We should enable debugging dynamic accesses when the static shell
  // debugging has been enabled and we're also in development mode.
  const isDebugDynamicAccesses =
    isDebugStaticShell && routeModule.isDev === true

  const isRSCRequest =
    getRequestMeta(req, 'isRSCRequest') || Boolean(req.headers[RSC_HEADER])

  // If we're in production or we're debugging the fallback
  // shell then we should postpone when dynamic params are
  // accessed.
  const fallbackRouteParams =
    isRoutePPREnabled &&
    !isRSCRequest &&
    (!routeModule.isDev || isDebugFallbackShell)
      ? getFallbackRouteParams(srcPage)
      : null

  const ComponentMod = {
    ...entryBase,
    tree,
    pages,
    GlobalError,
    handler,
    routeModule,
    __next_app__,
  }

  // Before rendering (which initializes component tree modules), we have to
  // set the reference manifests to our global store so Server Action's
  // encryption util can access to them at the top level of the page module.
  if (serverActionsManifest && clientReferenceManifest) {
    setReferenceManifestsSingleton({
      page: srcPage,
      clientReferenceManifest,
      serverActionsManifest,
      serverModuleMap: createServerModuleMap({
        serverActionsManifest,
      }),
    })
  }

  try {
    const method = req.method || 'GET'
    const tracer = getTracer()

    const activeSpan = tracer.getActiveScopeSpan()

    const invokeRouteModule = async (span?: Span) =>
      routeModule
        .render(new NodeNextRequest(req), new NodeNextResponse(res), {
          query,
          params,
          page: srcPage,
          sharedContext: {
            buildId,
          },
          fallbackRouteParams,
          renderOpts: {
            App: () => null,
            Document: () => null,
            pageConfig: {},
            ComponentMod,
            Component: interopDefault(ComponentMod),

            params,
            routeModule,
            page: srcPage,
            supportsDynamicResponse: !isIsr,
            buildManifest,
            nextFontManifest,
            reactLoadableManifest,
            subresourceIntegrityManifest,
            serverActionsManifest,
            clientReferenceManifest,

            dir: routeModule.projectDir,
            isDraftMode,
            assetPrefix: nextConfig.assetPrefix,
            nextConfigOutput: nextConfig.output,
            crossOrigin: nextConfig.crossOrigin,
            trailingSlash: nextConfig.trailingSlash,
            previewProps: prerenderManifest.preview,
            // fix issue with readonly regex object type
            htmlLimitedBots: nextConfig.htmlLimitedBots as any as string,
            reactMaxHeadersLength: nextConfig.reactMaxHeadersLength,

            multiZoneDraftMode,
            basePath: nextConfig.basePath,

            ...(isDebugStaticShell || isDebugDynamicAccesses
              ? {
                  nextExport: true,
                  supportsDynamicResponse: false,
                  isStaticGeneration: true,
                  isRevalidate: true,
                  isDebugDynamicAccesses: isDebugDynamicAccesses,
                }
              : {}),

            experimental: {
              isRoutePPREnabled,
              expireTime: nextConfig.expireTime,
              staleTimes: nextConfig.experimental.staleTimes,
              dynamicIO: Boolean(nextConfig.experimental.dynamicIO),
              clientSegmentCache: Boolean(
                nextConfig.experimental.clientSegmentCache
              ),
              dynamicOnHover: Boolean(nextConfig.experimental.dynamicOnHover),
              inlineCss: Boolean(nextConfig.experimental.inlineCss),
              authInterrupts: Boolean(nextConfig.experimental.authInterrupts),
              clientTraceMetadata:
                nextConfig.experimental.clientTraceMetadata || ([] as any),
            },

            waitUntil: ctx.waitUntil,
            onClose: () => {},
            onAfterTaskError: () => {},

            err: getRequestMeta(req, 'invokeError'),
            dev: routeModule.isDev,
          },
        })
        .finally(() => {
          if (!span) return

          span.setAttributes({
            'http.status_code': res.statusCode,
            'next.rsc': false,
          })

          const rootSpanAttributes = tracer.getRootSpanAttributes()
          // We were unable to get attributes, probably OTEL is not enabled
          if (!rootSpanAttributes) {
            return
          }

          if (
            rootSpanAttributes.get('next.span_type') !==
            BaseServerSpan.handleRequest
          ) {
            console.warn(
              `Unexpected root span type '${rootSpanAttributes.get(
                'next.span_type'
              )}'. Please report this Next.js issue https://github.com/vercel/next.js`
            )
            return
          }

          const route = rootSpanAttributes.get('next.route')
          if (route) {
            const name = `${method} ${route}`

            span.setAttributes({
              'next.route': route,
              'http.route': route,
              'next.span_name': name,
            })
            span.updateName(name)
          } else {
            span.updateName(`${method} ${req.url}`)
          }
        })

    // TODO: activeSpan code path is for when wrapped by
    // next-server can be removed when this is no longer used
    if (activeSpan) {
      return await invokeRouteModule(activeSpan)
    } else {
      return await tracer.withPropagatedContext(req.headers, () =>
        tracer.trace(
          BaseServerSpan.handleRequest,
          {
            spanName: `${method} ${req.url}`,
            kind: SpanKind.SERVER,
            attributes: {
              'http.method': method,
              'http.target': req.url,
            },
          },
          invokeRouteModule
        )
      )
    }
  } catch (err) {
    await onError(
      req,
      err,
      {
        path: req.url || '/',
        headers: req.headers,
        method: req.method || 'GET',
      },
      {
        routerKind: 'App Router',
        routePath: srcPage,
        routeType: 'render',
        revalidateReason: getRevalidateReason({
          isRevalidate: isIsr,
          isOnDemandRevalidate,
        }),
      }
    )

    // rethrow so that we can handle serving error page
    throw err
  } finally {
    // We don't allow any waitUntil work in pages API routes currently
    // so if callback is present return with resolved promise since no
    // pending work
    ctx.waitUntil?.(Promise.resolve())
  }
}
