// Rules for the side-by-side batch: which providers may be compared at once, which of them the browser can call,
// which of them still need a key, and how the saved rows are grouped into one column per provider.
// The page reads these rules; it does not decide them. Every function here is pure: no storage, no network, no DOM.

// The most providers that can be compared at once. The command line uses the same limit (ordeal test takes up to 3).
export const MAX_SIDE_PROVIDERS = 3;
// The message shown when a fourth provider is chosen. It is refused, so the existing three stay as they are.
export const TOO_MANY_PROVIDERS_MESSAGE = 'You can compare up to 3 providers at once. Remove one before adding another.';

// The only hosts this site may send requests to. This must match the connect-src line in netlify.toml, which a test
// checks. Widening it needs the owner's approval, so a provider on any other host is shown as unavailable instead.
export const BROWSER_ALLOWED_HOSTS = Object.freeze(['api.tokenfactory.nebius.com']);

// The three states a provider can be in on the side-by-side page.
export const STATUS_READY = 'ready';
export const STATUS_MISSING_KEY = 'missing-key';
export const STATUS_UNAVAILABLE = 'unavailable';

/**
 * Return the list of chosen provider ids with one more added. Choosing an id that is already in the list changes nothing.
 * A fourth distinct provider throws the plain message, so the page can show it and keep the list as it was.
 */
export function addSideProvider(chosenIds, providerId) {
  if (chosenIds.includes(providerId)) return chosenIds;
  if (chosenIds.length >= MAX_SIDE_PROVIDERS) throw new Error(TOO_MANY_PROVIDERS_MESSAGE);
  return [...chosenIds, providerId];
}

/** Return the host part of an address such as https://api.example.com/v1, or null when it is missing or not a URL. */
function hostOf(address) {
  if (typeof address !== 'string') return null;
  try {
    return new URL(address).host;
  } catch {
    return null;
  }
}

/**
 * Say whether the browser may call this provider. A provider is reachable only when it is marked for the browser and
 * its address is on the allowed list. Otherwise the reason says what to do: run the test from the command line.
 */
export function browserReachability(platform, allowedHosts = BROWSER_ALLOWED_HOSTS) {
  const host = hostOf(platform.base_url);
  if (platform.browser === true && host !== null && allowedHosts.includes(host)) {
    return { reachable: true, reason: '' };
  }
  const reason =
    `${platform.name} cannot be called from this page. This site may only send requests to ` +
    `${allowedHosts.join(', ')}. Run it from the command line instead: ordeal test ${platform.id} <model>`;
  return { reachable: false, reason };
}

/**
 * Work out the state of one chosen provider. An unknown id is unavailable. A provider the browser cannot call is
 * unavailable with its reason, even when a key is saved. A reachable provider with no key is missing-key. Otherwise ready.
 * hasKey is a function from a provider id to true or false. No key text is ever part of the result.
 */
function statusFor(providerId, platforms, hasKey, allowedHosts) {
  const platform = platforms.find((entry) => entry.id === providerId);
  if (platform === undefined) {
    return { id: providerId, name: providerId, status: STATUS_UNAVAILABLE, reason: `${providerId} is not on the platform list.` };
  }
  const reach = browserReachability(platform, allowedHosts);
  if (!reach.reachable) {
    return { id: providerId, name: platform.name, status: STATUS_UNAVAILABLE, reason: reach.reason };
  }
  if (!hasKey(providerId)) {
    const reason = `No key is saved for ${platform.name}. Enter a key for ${platform.name} to run it.`;
    return { id: providerId, name: platform.name, status: STATUS_MISSING_KEY, reason };
  }
  return { id: providerId, name: platform.name, status: STATUS_READY, reason: '' };
}

/**
 * Return one status for each chosen provider, in the order they were chosen. Each provider is judged on its own,
 * so one missing key or one blocked provider never changes the status of another.
 */
export function sideProviderStatuses(chosenIds, platforms, hasKey, allowedHosts = BROWSER_ALLOWED_HOSTS) {
  return chosenIds.map((providerId) => statusFor(providerId, platforms, hasKey, allowedHosts));
}

/** Return the ids of the providers that can run now, in order. Only these get a run; the others are not sent anything. */
export function runnableProviderIds(statuses) {
  return statuses.filter((entry) => entry.status === STATUS_READY).map((entry) => entry.id);
}

/**
 * Split the saved rows into one group per chosen provider, in the order the providers were chosen. A row is put in the
 * group named by its provider field. A chosen provider with no rows still gets an empty group, so its column stays visible.
 */
export function groupRowsByProvider(rows, chosenIds) {
  return chosenIds.map((providerId) => ({
    id: providerId,
    rows: rows.filter((row) => row.provider === providerId),
  }));
}

/**
 * Return the part of a run's settings that must match for two providers to be compared fairly: the suite, the
 * condition, the seed, the repeats and the question ids (sorted, so their order does not matter). The result is a
 * string, so two settings can be compared with ===.
 */
export function comparisonKey(settings) {
  const questions = [...(settings.questions ?? [])].sort();
  return JSON.stringify([settings.suite ?? null, settings.condition ?? null, settings.seed ?? null, settings.repeats ?? null, questions]);
}

// The short text the panel shows for each state of a provider.
const BADGE_TEXT = {
  [STATUS_READY]: 'Ready',
  [STATUS_MISSING_KEY]: 'Needs a key',
  [STATUS_UNAVAILABLE]: 'Not available here',
};

/**
 * Return the label for one provider's state and which buttons it allows. A provider can be used for the batch only when
 * it is ready. It can take a key unless the browser cannot call it at all, since a key would be of no use there.
 */
export function rowLabelsFor(status) {
  return {
    badge: BADGE_TEXT[status.status] ?? BADGE_TEXT[STATUS_UNAVAILABLE],
    canUse: status.status === STATUS_READY,
    canAddKey: status.status !== STATUS_UNAVAILABLE,
  };
}

/** Return true when every run in the list has the same comparison key. A list of zero or one run is always the same. */
export function sameComparison(settingsList) {
  if (settingsList.length <= 1) return true;
  const first = comparisonKey(settingsList[0]);
  return settingsList.every((settings) => comparisonKey(settings) === first);
}
