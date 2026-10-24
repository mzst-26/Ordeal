**DIRECT**

## Evidence

| Origin | HTTP status | Allow-Origin | Allow-Headers | Redirect | Notes |
|---|---|---|---|---|---|
| https://example.netlify.app | 204 | `*` | `authorization,content-type` | None | Allow-Methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT. Max-Age: 600. Empty body (0 bytes). |
| http://127.0.0.1:8080 | 204 | `*` | `authorization,content-type` | None | Same headers as the Netlify origin. Local preview also allowed. |

Both preflights were OPTIONS requests with no Authorization header and no POST. The network was reachable from this machine.

## Why

The Netlify origin preflight returned a 2xx status, `Access-Control-Allow-Origin: *`, and `authorization` in `Access-Control-Allow-Headers`. All three conditions in the decision rule are met, so the decision is DIRECT. The local preview origin gets the same answer, so local testing needs no proxy either.

## Consequence for the site

The decision is DIRECT. The page sends requests from the browser to `https://api.tokenfactory.nebius.com/v1/chat/completions` with the header `Authorization: Bearer <key typed by the user>`. No Netlify Function is needed for model calls. The page should not send cookies or credentials with these requests, because the response uses `*` for Allow-Origin.

## Privacy notes

- The key stays in JavaScript memory only, in both the DIRECT and PROXY cases.
- Do not store the key in localStorage, sessionStorage, cookies, URLs or logs.
- Do not put the key in the page HTML, query strings or console output.
- Clear the key from memory when the user leaves the page or chooses to forget it.
- Preflight results do not prove the API accepts this key. They only show the browser is allowed to send the request.
