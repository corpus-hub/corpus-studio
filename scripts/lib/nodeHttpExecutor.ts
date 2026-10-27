import { request as httpRequest, type ClientRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { HttpExecutor, configureRequestUrl, type DownloadOptions } from 'builder-util-runtime'

/**
 * electron-updater's HTTP layer, backed by Node rather than Electron's `net`.
 *
 * Only `createRequest` is abstract — redirects, retries, digest checking and
 * progress all live in the base class, so this really is the whole difference.
 * It exists for `scripts/verify-updater.ts`, which drives the update client
 * without an Electron app and therefore without a net session.
 *
 * NOT used by the app. A release goes through Electron's own executor, which is
 * what respects the user's proxy and certificate settings.
 */
export class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(options: RequestOptions, callback: (response: unknown) => void): ClientRequest {
    const send = options.protocol === 'http:' ? httpRequest : httpsRequest
    return send(options, callback as never)
  }

  /**
   * Fetch a file to disk.
   *
   * `download` is not on the abstract base — Electron's executor adds it — so
   * it is implemented here on top of `doDownload`, which is. That is where the
   * digest verification lives, so the sha512 from the manifest is still checked
   * exactly as it is in the app.
   */
  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const requestOptions: RequestOptions = { headers: options.headers ?? undefined }
      configureRequestUrl(url, requestOptions)
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel: () => undefined,
          callback: (error) => (error == null ? resolve(destination) : reject(error)),
          responseHandler: null
        },
        0
      )
    })
  }
}
