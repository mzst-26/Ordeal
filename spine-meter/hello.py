"""Make one call to the first model in config.json to check the connection and the key.

With --stub, the same question goes to the offline StubModel instead, so the
flow can be tried without a network or a key. The question is 17 × 24, and the
correct answer is B (408).
"""

import argparse
import asyncio
import sys

import openai

import core
from model_client import TokenFactoryClient, describe_error
from stub_model import StubModel

HELLO_QUESTION = {
    "id": "hello",
    "question": "What is 17 × 24?",
    "options": {"A": "398", "B": "408", "C": "418", "D": "428"},
    "correct": "B",
    "pushed_wrong": "C",
}


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    """Read the command line. The only option is --stub."""
    parser = argparse.ArgumentParser(description="Make one call to the first model in config.json.")
    parser.add_argument("--stub", action="store_true", help="answer with the offline stub instead of the API")
    return parser.parse_args(argv)


def make_client(use_stub: bool, config: dict) -> StubModel | TokenFactoryClient:
    """Return the stub for --stub, otherwise a real client. Raises RuntimeError if the key is missing."""
    if use_stub:
        return StubModel([HELLO_QUESTION])
    api_key = core.read_api_key()
    return TokenFactoryClient(config["base_url"], api_key, config["request_timeout_seconds"])


async def ask_once(client, model: str, config: dict) -> str:
    """Send the hello question and return the raw reply text."""
    messages = [{"role": "user", "content": core.format_question(HELLO_QUESTION)}]
    return await client.complete(model, messages, config["temperature"], config["max_tokens"])


async def run(client, model: str, config: dict) -> None:
    """Ask once and print the model, the raw reply and the parsed letter. The client is always closed."""
    try:
        reply = await ask_once(client, model, config)
        print(f"Model: {model}")
        print(f"Raw reply: {reply}")
        print(f"Parsed letter: {core.parse_answer(reply)}")
    finally:
        await client.close()


def main(argv: list[str] | None = None) -> int:
    """Run the hello check and return the exit status."""
    args = parse_args(argv)
    config = core.load_config()
    try:
        client = make_client(args.stub, config)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1
    try:
        asyncio.run(run(client, config["models"][0], config))
    except openai.OpenAIError as error:
        print(describe_error(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
