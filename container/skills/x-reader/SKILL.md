---
name: x-reader
description: >
  Free X/Twitter post reader via FxTwitter API. Read tweets, threads, profiles,
  and user timelines without an API key or authentication.
  Use when: user shares an x.com or twitter.com link, asks to read a tweet/thread,
  asks "what did @someone post", wants to check someone's recent tweets,
  or asks about Twitter/X discussions.
  NOT for: posting tweets, account management, or searching (search requires auth).
---

# X/Twitter Reader (FxTwitter API)

Read X/Twitter content via FxTwitter — a free public API that requires no authentication.

## Read a Single Tweet

Extract tweet ID from the URL and fetch via API:

```bash
curl -s "https://api.fxtwitter.com/status/TWEET_ID" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const t = d.tweet;
  if (!t) { console.log('Tweet not found'); process.exit(0); }
  console.log('@' + t.author.screen_name + ' (' + t.author.name + ')');
  console.log('Posted:', t.created_at);
  console.log('');
  console.log(t.text);
  console.log('');
  console.log('❤️', t.likes, '| 🔁', t.retweets, '| 💬', t.replies, '| 👁', t.views || 'N/A');
  if (t.media?.all?.length) {
    console.log('');
    console.log('Media:');
    t.media.all.forEach(m => console.log(' ', m.type + ':', m.url));
  }
  if (t.quote) {
    console.log('');
    console.log('Quoted tweet by @' + t.quote.author.screen_name + ':');
    console.log(t.quote.text);
  }
"
```

**Tweet ID** is the number at the end of the URL: `x.com/user/status/1234567890` → ID is `1234567890`.

Also works with full URLs — just extract the ID first:
```bash
# From URL like https://x.com/leopardracer/status/2035999459729895493
curl -s "https://api.fxtwitter.com/status/2035999459729895493" | node -e "..."
```

## Read a User's Recent Tweets

```bash
curl -s "https://api.fxtwitter.com/USERNAME" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const u = d.user;
  if (!u) { console.log('User not found'); process.exit(0); }
  console.log('@' + u.screen_name + ' (' + u.name + ')');
  console.log('Bio:', u.description);
  console.log('Followers:', u.followers, '| Following:', u.following);
  console.log('Tweets:', u.tweets);
  console.log('Joined:', u.joined);
  if (u.website) console.log('Website:', u.website);
"
```

## Read a Thread / Conversation

FxTwitter doesn't have a dedicated thread endpoint, but you can:

1. Fetch the root tweet to see its text
2. Check if it has `replying_to` field (indicates it's part of a thread)
3. Follow the conversation by fetching linked tweet IDs

```bash
# Fetch tweet and check for thread/reply context
curl -s "https://api.fxtwitter.com/status/TWEET_ID" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const t = d.tweet;
  if (t.replying_to) console.log('Reply to:', t.replying_to);
  if (t.quote) console.log('Quotes tweet by @' + t.quote.author.screen_name);
  console.log('');
  console.log('@' + t.author.screen_name + ':');
  console.log(t.text);
"
```

## Combine Multiple Tweets

To read several tweets at once (e.g., a thread you manually collected):

```bash
for ID in 123456 789012 345678; do
  echo "---"
  curl -s "https://api.fxtwitter.com/status/$ID" | node -e "
    const t = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).tweet;
    if (t) console.log('@' + t.author.screen_name + ': ' + t.text);
  "
done
```

## URL Formats

All these URL formats work — just extract the tweet ID:
- `https://x.com/user/status/1234567890`
- `https://twitter.com/user/status/1234567890`
- `https://x.com/user/status/1234567890?s=20`

## Limitations

- **No search** — FxTwitter doesn't support search queries
- **No timeline browsing** — can read profiles but not paginated timelines
- **Rate limits** — generous but undocumented; avoid rapid-fire requests
- **Media** — URLs to images/videos are included in the response
- **Deleted tweets** — will return empty/error response
