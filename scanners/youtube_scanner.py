#!/usr/bin/env python3
"""
YouTube channel scanner — fetches latest videos via RSS feed.
No API key required.

Usage:
    python youtube_scanner.py @mkbhd
    python youtube_scanner.py UCBcRF18a7Qf58cCRy5xuWwQ
    python youtube_scanner.py https://www.youtube.com/@mkbhd
    python youtube_scanner.py --pretty @mkbhd
    python youtube_scanner.py --config ./config.yaml
"""

import argparse
import html
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

import feedparser
import requests

CHANNEL_FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
YOUTUBE_CHANNEL_PAGE = "https://www.youtube.com/{handle}"

# YouTube serves a consent gate without this cookie.
# CONSENT=YES+ bypasses the EU consent wall; SOCS is a secondary consent token.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": "CONSENT=YES+; SOCS=CAESEwgDEgk0NDE4OTc5MDQaAmVuIAEaBgiA_LyaBg",
}

# Canonical link tag is the most reliable channel ID source.
# Falls back to browseId / channelId embedded in page JSON.
CHANNEL_ID_PATTERNS = [
    re.compile(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[a-zA-Z0-9_-]{22})"'),
    re.compile(r'"browseId":"(UC[a-zA-Z0-9_-]{22})"'),
    re.compile(r'"channelId":"(UC[a-zA-Z0-9_-]{22})"'),
    re.compile(r'"externalChannelId":"(UC[a-zA-Z0-9_-]{22})"'),
]


def extract_channel_id_from_url(url: str) -> str | None:
    """Extract a bare channel ID from a YouTube URL, or return None."""
    m = re.search(r"channel/(UC[a-zA-Z0-9_-]{22})", url)
    return m.group(1) if m else None


def looks_like_channel_id(s: str) -> bool:
    return bool(re.fullmatch(r"UC[a-zA-Z0-9_-]{22}", s))


def resolve_channel_id(identifier: str) -> str:
    """
    Given a handle (@username), channel ID, or YouTube URL, return channel ID.
    Raises ValueError if resolution fails.
    """
    identifier = identifier.strip()

    # Direct channel URL: https://www.youtube.com/channel/UC...
    direct = extract_channel_id_from_url(identifier)
    if direct:
        return direct

    # Already a bare channel ID
    if looks_like_channel_id(identifier):
        return identifier

    # Normalise handle
    if identifier.startswith("https://") or identifier.startswith("http://"):
        handle_match = re.search(r"youtube\.com/(@[^/?#\s]+)", identifier)
        if handle_match:
            identifier = handle_match.group(1)
        else:
            slug_match = re.search(r"youtube\.com/(?:c/|user/)?([^/?#\s]+)", identifier)
            if slug_match:
                identifier = "@" + slug_match.group(1)

    # Build fetch URL
    if identifier.startswith("@"):
        fetch_url = YOUTUBE_CHANNEL_PAGE.format(handle=identifier)
    else:
        fetch_url = f"https://www.youtube.com/@{identifier}"

    try:
        resp = requests.get(fetch_url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise ValueError(f"Failed to fetch channel page for '{identifier}': {e}") from e

    html = resp.text
    for pattern in CHANNEL_ID_PATTERNS:
        m = pattern.search(html)
        if m:
            return m.group(1)

    raise ValueError(
        f"Could not find channel ID on page for '{identifier}'. "
        "YouTube may have changed its page structure."
    )


def fetch_videos(channel_id: str, limit: int = 15) -> list[dict]:
    """Fetch up to `limit` latest videos from channel RSS feed."""
    feed_url = CHANNEL_FEED_URL.format(channel_id=channel_id)

    try:
        resp = requests.get(feed_url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise ValueError(f"Failed to fetch RSS feed for channel '{channel_id}': {e}") from e

    try:
        feed = feedparser.parse(resp.content)
    except Exception as e:
        raise ValueError(f"Failed to parse RSS feed: {e}") from e

    if not feed.entries:
        raise ValueError(
            f"RSS feed returned no entries for channel '{channel_id}'. "
            "Channel may be private, deleted, or the ID is wrong."
        )

    videos = []
    for entry in feed.entries[:limit]:
        raw_desc = ""
        if hasattr(entry, "summary"):
            raw_desc = entry.summary
        elif hasattr(entry, "description"):
            raw_desc = entry.description

        clean_desc = html.unescape(re.sub(r"<[^>]+>", "", raw_desc)).strip()
        snippet = clean_desc[:300] + ("..." if len(clean_desc) > 300 else "")

        published = ""
        if hasattr(entry, "published"):
            published = entry.published

        duration = None
        if hasattr(entry, "yt_duration"):
            duration = entry.yt_duration
        elif hasattr(entry, "media_content"):
            for mc in entry.media_content:
                if "duration" in mc:
                    duration = mc["duration"]
                    break

        views = None
        if hasattr(entry, "yt_statistics"):
            views = entry.yt_statistics.get("viewcount")

        videos.append(
            {
                "title": entry.get("title", ""),
                "published": published,
                "url": entry.get("link", ""),
                "video_id": entry.get("yt_videoid", ""),
                "duration_seconds": duration,
                "views": views,
                "description_snippet": snippet,
                "channel_name": feed.feed.get("title", ""),
                "channel_id": channel_id,
            }
        )

    return videos


def format_duration(seconds_str: str | None) -> str:
    if not seconds_str:
        return "unknown"
    try:
        s = int(seconds_str)
        h, rem = divmod(s, 3600)
        m, sec = divmod(rem, 60)
        if h:
            return f"{h}:{m:02d}:{sec:02d}"
        return f"{m}:{sec:02d}"
    except (ValueError, TypeError):
        return seconds_str


def scan_config(config_path: str) -> list[dict]:
    """
    Read config.yaml and scan all configured channels.
    Returns filtered list of recent videos (within max_age_hours).
    """
    try:
        import yaml
        from dateutil.parser import parse as parse_date
    except ImportError:
        raise RuntimeError("Missing deps: pip install pyyaml python-dateutil")

    with open(config_path) as f:
        cfg = yaml.safe_load(f)

    yt_cfg = cfg.get("sources", {}).get("youtube", {})
    if not yt_cfg.get("enabled", True):
        return []

    channels = yt_cfg.get("channels", [])
    max_hours = yt_cfg.get("max_age_hours", 24)
    exclude_shorts = yt_cfg.get("exclude_shorts", True)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_hours)

    def fetch_channel(ch):
        handle = ch.get("handle", "")
        label = ch.get("label", handle)
        if not handle:
            return []
        try:
            videos = fetch_videos(resolve_channel_id(handle), limit=15)
            channel_results = []
            for v in videos:
                url = v.get("url", "")
                if exclude_shorts and "/shorts/" in url:
                    continue
                try:
                    pub = parse_date(v["published"])
                    if pub < cutoff:
                        continue
                except Exception:
                    pass
                channel_results.append({
                    "title": v["title"],
                    "url": url,
                    "channel": label,
                    "published": v["published"],
                    "duration_seconds": v.get("duration_seconds"),
                    "views": v.get("views"),
                })
            return channel_results
        except Exception as e:
            print(json.dumps({"warning": f"Channel {handle} failed: {e}"}), file=sys.stderr)
            return []

    results = []
    with ThreadPoolExecutor(max_workers=min(len(channels), 8)) as executor:
        futures = {executor.submit(fetch_channel, ch): ch for ch in channels}
        for future in as_completed(futures):
            results.extend(future.result())

    return results


def pretty_print(videos: list[dict]) -> None:
    if not videos:
        print("No videos found.")
        return

    channel_name = videos[0].get("channel_name", videos[0].get("channel", "Unknown channel"))
    print(f"\nChannel: {channel_name}")
    print(f"Latest {len(videos)} videos\n")
    print("-" * 72)

    for i, v in enumerate(videos, 1):
        duration = format_duration(v.get("duration_seconds"))
        views = f"  |  {int(v['views']):,} views" if v.get("views") else ""
        print(f"{i:2}. {v['title']}")
        print(f"    Published : {v['published']}")
        print(f"    URL       : {v['url']}")
        print(f"    Duration  : {duration}{views}")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch latest YouTube videos from a channel via RSS (no API key needed)."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "channel",
        nargs="?",
        help="Channel handle (@mkbhd), channel ID (UC...), or YouTube URL",
    )
    group.add_argument(
        "--config",
        metavar="PATH",
        help="Path to config.yaml — scan all configured channels",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Human-readable output instead of JSON",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=15,
        help="Max number of videos per channel (default: 15)",
    )
    args = parser.parse_args()

    try:
        if args.config:
            videos = scan_config(args.config)
        else:
            videos = fetch_videos(resolve_channel_id(args.channel), limit=args.limit)
    except (ValueError, RuntimeError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    if args.pretty:
        pretty_print(videos)
    else:
        print(json.dumps(videos, indent=2))


if __name__ == "__main__":
    main()
