#!/usr/bin/env python3
"""
Hacker News front page scanner.
Fetches top stories via the official HN Firebase API.

Usage:
    python hn_scanner.py
    python hn_scanner.py --limit 20 --pretty
    python hn_scanner.py --min-score 200
    python hn_scanner.py --config ./config.yaml
    python hn_scanner.py --show-hn --pretty
    python hn_scanner.py --ask-hn --limit 5
"""

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

TOP_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json"
ITEM_URL = "https://hacker-news.firebaseio.com/v0/item/{id}.json"

HEADERS = {"User-Agent": "open-antenna-hn-scanner/0.1"}

MAX_WORKERS = 10


def fetch_top_story_ids(limit: int = 30) -> list[int]:
    """Fetch the list of current top story IDs from HN."""
    try:
        resp = requests.get(TOP_STORIES_URL, headers=HEADERS, timeout=10)
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        raise RuntimeError("Request timed out fetching top stories list.")
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"Connection error: {e}") from e
    except requests.exceptions.HTTPError as e:
        raise RuntimeError(f"HTTP error fetching top stories: {e}") from e

    try:
        ids = resp.json()
    except ValueError:
        raise RuntimeError("HN API returned invalid JSON for top stories list.")

    if not isinstance(ids, list):
        raise RuntimeError(f"Unexpected response format: {type(ids)}")

    return ids[:limit]


def fetch_item(item_id: int) -> dict | None:
    """Fetch a single HN item by ID. Returns None on any error."""
    url = ITEM_URL.format(id=item_id)
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return None

    if not data:
        return None

    created_date = None
    if data.get("time"):
        created_date = datetime.fromtimestamp(data["time"], tz=timezone.utc).isoformat()

    return {
        "id": data.get("id"),
        "type": data.get("type"),
        "title": data.get("title"),
        "url": data.get("url"),
        "score": data.get("score", 0),
        "comment_count": data.get("descendants", 0),
        "author": data.get("by"),
        "created_date": created_date,
        "hn_url": f"https://news.ycombinator.com/item?id={data.get('id')}",
    }


def fetch_stories(
    limit: int = 30,
    min_score: int | None = None,
    show_hn: bool = False,
    ask_hn: bool = False,
) -> list[dict]:
    """
    Fetch top HN stories in parallel.

    When filtering, we over-fetch because the top stories list is not pre-filtered.
    """
    fetch_limit = limit * 5 if (show_hn or ask_hn or min_score) else limit
    fetch_limit = min(fetch_limit, 500)

    ids = fetch_top_story_ids(fetch_limit)

    items: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_id = {executor.submit(fetch_item, story_id): story_id for story_id in ids}
        for future in as_completed(future_to_id):
            story_id = future_to_id[future]
            result = future.result()
            if result:
                items[story_id] = result

    # Preserve original ranking order
    stories = [items[i] for i in ids if i in items]

    if show_hn:
        stories = [s for s in stories if s.get("title", "").startswith("Show HN:")]
    elif ask_hn:
        stories = [s for s in stories if s.get("title", "").startswith("Ask HN:")]

    if min_score is not None:
        stories = [s for s in stories if (s.get("score") or 0) >= min_score]

    return stories[:limit]


def scan_config(config_path: str) -> list[dict]:
    """Read config.yaml and scan HN with configured settings."""
    try:
        import yaml
    except ImportError:
        raise RuntimeError("Missing deps: pip install pyyaml")

    with open(config_path) as f:
        cfg = yaml.safe_load(f)

    hn_cfg = cfg.get("sources", {}).get("hackernews", {})
    if not hn_cfg.get("enabled", True):
        return []

    return fetch_stories(
        limit=hn_cfg.get("top_n", 20),
        min_score=hn_cfg.get("min_score"),
    )


def format_pretty(stories: list[dict]) -> str:
    if not stories:
        return "No stories matched the criteria."

    lines = [f"Hacker News — top {len(stories)} stories", "=" * 70]
    for i, s in enumerate(stories, 1):
        url = s.get("url") or s.get("hn_url", "")
        lines.append(f"\n[{i}] {s['title']}")
        lines.append(f"    Score: {s['score']}  |  Comments: {s['comment_count']}  |  By: {s['author']}")
        lines.append(f"    Posted: {s['created_date']}")
        lines.append(f"    URL: {url}")
        if s.get("url"):
            lines.append(f"    HN:  {s['hn_url']}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch top stories from Hacker News via the official API."
    )
    parser.add_argument(
        "--config",
        metavar="PATH",
        help="Path to config.yaml — use configured HN settings",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Number of stories to return (default: 20)",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=None,
        metavar="N",
        help="Only return stories with score >= N",
    )
    parser.add_argument(
        "--show-hn",
        action="store_true",
        help="Only return Show HN posts",
    )
    parser.add_argument(
        "--ask-hn",
        action="store_true",
        help="Only return Ask HN posts",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Human-readable output instead of JSON",
    )
    args = parser.parse_args()

    if args.show_hn and args.ask_hn:
        print(json.dumps({"error": "--show-hn and --ask-hn are mutually exclusive"}), file=sys.stderr)
        sys.exit(1)

    try:
        if args.config:
            stories = scan_config(args.config)
        else:
            stories = fetch_stories(
                limit=args.limit,
                min_score=args.min_score,
                show_hn=args.show_hn,
                ask_hn=args.ask_hn,
            )
    except (RuntimeError, ValueError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    if args.pretty:
        print(format_pretty(stories))
    else:
        print(json.dumps({"story_count": len(stories), "stories": stories}, indent=2))


if __name__ == "__main__":
    main()
