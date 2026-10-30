"""The ordeal command line: list platforms, save a key, find models, check one model, and run the test.

Each subcommand is a small function. The real work is done by the other modules: providers.py knows
which platforms exist and which model ids they serve, keys.py finds and saves keys, and runner.py and
grade.py run and grade the experiment. This file reads what the person typed, calls those modules, and
prints plain messages. A person can use it without writing any code.
"""

import argparse
import getpass
import hashlib
import re
import sys
from dataclasses import replace
from pathlib import Path

import openai

from ordeal import grade, keys, model_client, providers, runner

# How many model ids the models command prints before it asks for a --search.
MAX_MODELS_SHOWN = 50
# The check sends one short message, so the reply is capped at a few tokens to keep the call cheap.
CHECK_PROMPT = "Reply with the word ok."
CHECK_MAX_TOKENS = 5
CHECK_TIMEOUT_SECONDS = 60
# How many characters of the check reply are shown, so a long reply cannot flood the screen.
CHECK_REPLY_SHOWN = 80
# Length of the digest added to a cache file name. It keeps two model names that differ only in punctuation apart.
CACHE_DIGEST_LENGTH = 8
RESULTS_FOLDER_NAME = "results"
# The most providers one test command compares. Each provider is a full run, so a longer list is slow to read.
MAX_PROVIDERS = 3


def route_key(platform: providers.Platform) -> str:
    """Return the key a request to this platform needs.

    A local platform has no key, so it gets a fixed placeholder, because the openai client refuses an
    empty key. This is why the command line does not call model_client.attach_keys: that function reads
    keys from the environment only, and it fails for a platform with no key variable.
    """
    try:
        key = keys.get_key(platform)
    except RuntimeError as error:
        raise RuntimeError(f"{error} Or run: ordeal login {platform.id}") from error
    return key or providers.LOCAL_KEY_PLACEHOLDER


def resolve_route(platform: providers.Platform, text: str, base_url: str | None) -> model_client.ModelRoute:
    """Turn what the person typed into a route for a model that the platform really serves.

    The model is looked up in the platform's own list, so a typo is caught here, with suggestions,
    before any chat call is made. The route keeps the key that the request needs.
    """
    wanted = providers.parse_model_reference(platform, text)
    key = route_key(platform)
    available = providers.fetch_model_ids(platform, key, base_url)
    model_id = providers.find_model(platform, wanted, available)
    route = providers.route_for(platform, model_id, base_url)
    return replace(route, api_key=key)


def send_tiny_message(route: model_client.ModelRoute) -> str:
    """Send one short message to the model and return its reply text. This is the only chat call of 'check'."""
    client = openai.OpenAI(
        base_url=route.base_url,
        api_key=route.api_key,
        max_retries=0,
        timeout=CHECK_TIMEOUT_SECONDS,
    )
    response = client.chat.completions.create(
        model=route.api_model,
        messages=[{"role": "user", "content": CHECK_PROMPT}],
        max_tokens=CHECK_MAX_TOKENS,
    )
    return response.choices[0].message.content or ""


def key_status(platform: providers.Platform) -> str:
    """Return a short word for the key state of one platform. The key itself is never returned."""
    if platform.key_env is None:
        return "not needed"
    try:
        keys.get_key(platform)
    except RuntimeError:
        return "no"
    return "yes"


def cmd_platforms(args: argparse.Namespace) -> int:
    """Print every platform, its id, whether a key is saved, and its name."""
    print(f"{'Id':<14} {'Key':<11} Name")
    for platform in providers.load_platforms():
        print(f"{platform.id:<14} {key_status(platform):<11} {platform.name}")
    print("Save a key with: ordeal login <id>")
    return 0


def cmd_login(args: argparse.Namespace) -> int:
    """Ask for the key of one platform with hidden input, and save it in the credentials file.

    The key is typed with getpass, so it is never shown on screen and never stored in the shell history.
    """
    platform = providers.get_platform(args.platform)
    if platform.key_env is None:
        print(f"{platform.name} runs on this computer and needs no key.")
        return 0
    if platform.signup:
        print(f"Make a key at {platform.signup}")
    key = getpass.getpass(f"Paste the {platform.name} key (typing is hidden): ")
    keys.save_key(platform.id, key)
    print(f"Saved the key for {platform.name} in {keys.credentials_path()}. The key is not shown.")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    """Print the model ids a platform serves, filtered by --search when it is given."""
    platform = providers.get_platform(args.platform)
    ids = providers.fetch_model_ids(platform, route_key(platform), args.base_url)
    wanted = args.search.lower() if args.search else ""
    matches = [model_id for model_id in ids if wanted in model_id.lower()]
    for model_id in matches[:MAX_MODELS_SHOWN]:
        print(model_id)
    if len(matches) > MAX_MODELS_SHOWN:
        print(f"... and {len(matches) - MAX_MODELS_SHOWN} more. Use --search to narrow the list.")
    print(f"{len(matches)} model(s) on {platform.name}.")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Confirm that one model answers, by sending one short message to it."""
    platform = providers.get_platform(args.platform)
    route = resolve_route(platform, args.model, args.base_url)
    reply = send_tiny_message(route)
    shown = reply.strip()[:CHECK_REPLY_SHOWN]
    print(f"{route.name} answered: {shown!r}")
    return 0


def cache_file_name(platform_id: str, model_id: str) -> str:
    """Return the cache file name for one platform and model, such as groq__org_name-1a2b3c4d.jsonl.

    The readable part makes the file easy to find. The digest is taken from the full name, so two
    models whose names differ only in punctuation never share a cache file, and their runs never mix.
    """
    readable = re.sub(r"[^A-Za-z0-9.-]+", "_", model_id)
    digest = hashlib.sha256(f"{platform_id}/{model_id}".encode("utf-8")).hexdigest()[:CACHE_DIGEST_LENGTH]
    return f"{platform_id}__{readable}-{digest}.jsonl"


def results_folder() -> Path:
    """Return the folder for saved replies and tables: results/ in the folder the command is run from.

    The current folder is used, not the package folder, so an installed copy never writes into itself.
    """
    return Path.cwd() / RESULTS_FOLDER_NAME


def split_names(text: str, what: str) -> list[str]:
    """Split a comma list such as 'groq,together' into its parts.

    An empty part is refused, so a stray comma is seen at once instead of being read as a name.
    """
    parts = [part.strip() for part in text.split(",")]
    if any(not part for part in parts):
        raise ValueError(f"The {what} list has an empty entry: '{text}'. Separate the names with commas.")
    return parts


def parse_platform_ids(text: str) -> list[str]:
    """Return the platform ids named for one test: one to MAX_PROVIDERS, with none repeated.

    The count is checked here, before any key is read or any request is made, so a long list is refused at once.
    """
    ids = split_names(text, "provider")
    if len(ids) > MAX_PROVIDERS:
        raise ValueError(
            f"A test can compare at most {MAX_PROVIDERS} providers, but {len(ids)} were named. "
            "Remove some and try again."
        )
    repeated = sorted({platform_id for platform_id in ids if ids.count(platform_id) > 1})
    if repeated:
        raise ValueError(f"Name each provider once. Repeated: {', '.join(repeated)}.")
    return ids


def model_references(text: str, provider_count: int) -> list[str]:
    """Return one model name for each provider, in the order the providers were named.

    One model name is used for every provider, so the same model is run on each. Otherwise a model name is needed
    for each provider, so each provider can serve its own equivalent model.
    """
    names = split_names(text, "model")
    if len(names) == 1:
        return names * provider_count
    if len(names) == provider_count:
        return names
    raise ValueError(
        f"Name one model for all the providers, or one model per provider. "
        f"There are {provider_count} providers and {len(names)} model names."
    )


def cmd_test(args: argparse.Namespace) -> int:
    """Run the Ordeal experiment on one model per provider, then print the table of all of them.

    Options after the model name (such as --limit or --probes) go to the runner unchanged, and every provider
    gets the same options. Each provider's cache file is named after the platform and model, so its replies are
    kept apart. All routes are built before the first run, so a missing key stops the command before any call.
    """
    platform_ids = parse_platform_ids(args.platform)
    model_names = model_references(args.model, len(platform_ids))
    plans = []
    for platform_id, model_name in zip(platform_ids, model_names):
        platform = providers.get_platform(platform_id)
        route = resolve_route(platform, model_name, args.base_url)
        cache = results_folder() / cache_file_name(platform.id, route.api_model)
        plans.append((platform, route, cache))
    codes = []
    for number, (platform, route, cache) in enumerate(plans, start=1):
        if len(plans) > 1:
            print(f"Provider {number} of {len(plans)}: {platform.name}")
        # Our --cache comes first, so a --cache written by hand after it still wins, as the runner's own rule says.
        codes.append(runner.main(["--cache", str(cache), *args.extras], prebuilt_routes={route.name: route}))
    # Grade whatever was saved, even after a failed call, so the person can see the partial table. A code other
    # than 0 or 1 means a run did not really happen (bad option, missing key or a stop), so nothing is graded then.
    if all(code in (0, 1) for code in codes):
        grade_args = []
        for _, _, cache in plans:
            grade_args += ["--cache", str(cache)]
        grade.main([*grade_args, "--out-dir", str(results_folder())])
    return max(codes)


def add_base_url_option(parser: argparse.ArgumentParser) -> None:
    """Add --base-url. Only the custom platform needs it, because every other platform has a fixed address."""
    parser.add_argument(
        "--base-url",
        default=None,
        help="the address of the endpoint; needed only for the custom platform",
    )


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser with one subcommand for each task."""
    parser = argparse.ArgumentParser(
        prog="ordeal",
        description="Run the Ordeal sycophancy test on any model, from the terminal.",
    )
    commands = parser.add_subparsers(dest="command", metavar="command", required=True)

    commands.add_parser("platforms", help="list the platforms and whether a key is saved").set_defaults(
        run=cmd_platforms
    )

    login = commands.add_parser("login", help="save the key for a platform (typing is hidden)")
    login.add_argument("platform", help="platform id, such as groq (see: ordeal platforms)")
    login.set_defaults(run=cmd_login)

    models = commands.add_parser("models", help="list the models a platform serves")
    models.add_argument("platform", help="platform id")
    models.add_argument("--search", default=None, help="show only ids that contain this text")
    add_base_url_option(models)
    models.set_defaults(run=cmd_models)

    check = commands.add_parser("check", help="send one tiny message to confirm a model answers")
    check.add_argument("platform", help="platform id")
    check.add_argument("model", help="model id, such as org/name, or a link to its page")
    add_base_url_option(check)
    check.set_defaults(run=cmd_check)

    test = commands.add_parser(
        "test",
        help="run the Ordeal test on a model",
        epilog="Other options, such as --limit, --probes or --max-calls, are passed to the runner.",
    )
    test.add_argument(
        "platform",
        help=f"platform id, or up to {MAX_PROVIDERS} ids separated by commas, such as groq,together",
    )
    test.add_argument(
        "model",
        help="model id, such as org/name, or a link to its page; with several providers, one name for all of them "
        "or one per provider, separated by commas",
    )
    add_base_url_option(test)
    test.set_defaults(run=cmd_test)
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run one ordeal command and return its exit code: 0 for success, 1 for an error, or the runner's code.

    Errors are printed as plain text that says what to do next. Keys are never printed.
    """
    parser = build_parser()
    args, extras = parser.parse_known_args(argv)
    # Only 'test' passes unknown options on to the runner; any other command refuses them.
    if extras and args.run is not cmd_test:
        parser.error(f"unrecognized arguments: {' '.join(extras)}")
    args.extras = extras
    try:
        return args.run(args)
    except (ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    except openai.OpenAIError as error:
        print(
            f"Could not reach the platform. {model_client.describe_error(error)} "
            "Check the connection, or for a local platform check its server is running.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
