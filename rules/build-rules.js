// Source of truth for remote rules. Run: node rules/build-rules.js && node rules/sign-rules.js <key.pem>
const POSTS_YT = "ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-reel-item-renderer,ytd-grid-video-renderer,ytm-shorts-lockup-view-model,yt-lockup-view-model";
const rules = {
  version: 2,
  updated: "2026-10-24",
  sites: [
    { id: "google", hosts: "(^|\\.)google\\.[a-z.]+$", dateFilter: "google",
      containers: "div.g,div.MjjYud,div[data-hveid][data-ved]>div.g,g-inner-card,div.isv-r,div[data-lpage],div[jsname='dTDiAc']",
      hide: [
        { cat: "widgets", reason: "AI Overview", css: "div[data-mcpr],div[data-attrid='SrpGenSum'],div[jsname='txosbe'],div[data-subtree='aimc']" },
        { cat: "widgets", reason: "AI Overview", text: "^AI Overview$", in: "h1,h2,div[role='heading'],span,strong", up: "div[data-hveid][jscontroller],div[data-hveid],div[jsname]" },
        { cat: "widgets", reason: "AI Mode", css: "a[href*='udm=50']" },
        { cat: "widgets", reason: "AI Mode", aria: "^AI Mode$", up: "div[role='listitem'],a,button" }
      ] },
    { id: "bing", hosts: "(^|\\.)bing\\.com$", dateFilter: "bing",
      containers: "li.b_algo,div.iuscp,li[data-idx],div.imgpt,div.dg_u,.b_ans",
      linkAttrs: ["m"],
      hide: [
        { cat: "widgets", reason: "Copilot", css: "#b_sydConvCont,#b_copilot_answer,cib-serp,#codex,.b_genserp,#b-scopeListItem-conv,.copilot_tile,#b_copilotsearch" },
        { cat: "widgets", reason: "Copilot", text: "^(Copilot|Copilot Answer|Copilot Search)$", in: "h2,h3,span,a", up: ".b_ans,li,section" },
        { cat: "widgets", reason: "Copilot", aria: "Copilot", up: "li,a,button" }
      ] },
    { id: "duckduckgo", hosts: "(^|\\.)duckduckgo\\.com$",
      containers: "article[data-testid='result'],li[data-layout='organic'],div.tile--img,figure,div[data-testid='image-result'],li[data-testid='zci-images'] div",
      linkAttrs: ["data-id", "data-src"],
      hide: [
        { cat: "widgets", reason: "Search Assist", css: "[data-testid='aiAnswer'],[data-testid='assist-answer'],a[href*='duck.ai'],[data-testid='duckassist']" },
        { cat: "widgets", reason: "Search Assist", text: "^(Search Assist|Duck\\.ai|Assist)$", in: "h2,span,div", up: "section,article,div[data-testid]" }
      ] },
    { id: "brave", hosts: "(^|\\.)search\\.brave\\.com$",
      containers: "div.snippet,div.image-result,a.image-result,div[data-type='web'],div.result",
      hide: [
        { cat: "widgets", reason: "Brave AI answer", css: "#summarizer,.summarizer,div[data-type='summarizer'],#chatllm,.chatllm-wrapper" },
        { cat: "widgets", reason: "Brave AI answer", text: "^(Answer with AI|AI-generated answer|Summarizer)$", in: "h2,span,div,button", up: "section,div.card,div[id]" }
      ] },
    { id: "kagi", hosts: "(^|\\.)kagi\\.com$",
      containers: "div.search-result,div._0_SRI,div.image-result,div._0_image_item,div.__srgi",
      hide: [
        { cat: "widgets", reason: "Kagi Quick Answer", css: ".quick-answer,#qa-box,._0_quick_answer" },
        { cat: "widgets", reason: "Kagi Quick Answer", text: "^Quick Answer$", in: "h2,h3,span,div", up: "section,div[class]" }
      ] },
    { id: "youtube", hosts: "(^|\\.)youtube\\.com$",
      containers: POSTS_YT + ",ytd-comment-thread-renderer,ytd-channel-renderer",
      hide: [
        { cat: "labels", reason: "Altered or synthetic content", text: "(Altered or synthetic content|Synthetic content|AI-generated)", in: "span,div,yt-formatted-string,a", up: POSTS_YT + ",ytd-watch-metadata" },
        { cat: "widgets", reason: "YouTube Ask (AI)", aria: "^Ask$", up: "yt-button-view-model,button" },
        { cat: "widgets", reason: "YouTube Ask (AI)", css: "ytd-engagement-panel-section-list-renderer[target-id*='ask'],ytd-engagement-panel-section-list-renderer[target-id*='PAyouchat']" }
      ] },
    { id: "reddit", hosts: "(^|\\.)reddit\\.com$",
      containers: "shreddit-post,shreddit-comment,article,div.thing,faceplate-tracker[noun='post']",
      attrs: [
        { sel: "shreddit-post", attr: "content-href", kind: "url" },
        { sel: "shreddit-post", attr: "subreddit-prefixed-name", kind: "account", prefix: "reddit.com/" },
        { sel: "shreddit-post,shreddit-comment", attr: "author", kind: "account", prefix: "reddit.com/user/" },
        { sel: "div.thing", attr: "data-url", kind: "url" },
        { sel: "div.thing", attr: "data-subreddit-prefixed", kind: "account", prefix: "reddit.com/" },
        { sel: "div.thing", attr: "data-author", kind: "account", prefix: "reddit.com/user/" }
      ],
      hide: [
        { cat: "labels", reason: "AI flair", text: "^(AI|AI Art|AI Generated|AI-generated|AI Content|Made with AI|AI Image)$", in: "shreddit-post-flair *,span.flair,span.linkflairlabel,flair-tag *", up: "shreddit-post,div.thing,article" },
        { cat: "widgets", reason: "Reddit Answers (AI)", css: "a[href^='/answers'],a[href*='reddit.com/answers']" }
      ] },
    { id: "pinterest", hosts: "(^|\\.)pinterest\\.[a-z.]+$",
      containers: "div[data-grid-item='true'],div[data-test-id='pin'],div[role='listitem']",
      hide: [
        { cat: "labels", reason: "AI modified", text: "^(AI modified|AI-modified|Gen AI|AI generated|AI-generated)$", in: "div,span", up: "div[data-grid-item='true'],div[data-test-id='pin'],div[role='listitem']" },
        { cat: "labels", reason: "AI modified", aria: "(AI modified|AI-modified|Gen AI)", up: "div[data-grid-item='true'],div[data-test-id='pin']" }
      ] },
    { id: "x", hosts: "(^|\\.)(x|twitter)\\.com$",
      containers: "article,div[data-testid='cellInnerDiv'],div[data-testid='UserCell']",
      hide: [
        { cat: "labels", reason: "Made with AI", text: "^(Made with AI|AI-generated|AI generated)$", in: "span,div", up: "div[data-testid='cellInnerDiv'],article" },
        { cat: "widgets", reason: "Grok", css: "a[href='/i/grok'],a[href^='/i/grok'],button[aria-label='Grok actions'],[data-testid='GrokDrawer']" },
        { cat: "widgets", reason: "Grok", aria: "^Grok", up: "a,button" }
      ] },
    { id: "meta", hosts: "(^|\\.)(facebook|instagram|messenger|threads)\\.(com|net)$",
      containers: "article,[role='article'],div[data-pagelet^='FeedUnit']",
      hide: [
        { cat: "labels", reason: "AI info", text: "^(AI info|Made with AI|AI-generated)$", in: "span,a,div", up: "div[data-pagelet^='FeedUnit'],article,[role='article']" },
        { cat: "widgets", reason: "Meta AI", css: "a[href*='meta.ai'],[aria-label*='Meta AI']" },
        { cat: "widgets", reason: "Meta AI", aria: "Meta AI", up: "a,button,div[role='button']" }
      ] },
    { id: "tiktok", hosts: "(^|\\.)tiktok\\.com$",
      containers: "[data-e2e='recommend-list-item-container'],article,div[class*='DivItemContainer']",
      hide: [ { cat: "labels", reason: "AI-generated", text: "^(AI-generated|Creator labeled as AI-generated|Contains AI-generated media)$", in: "span,div,p", up: "[data-e2e='recommend-list-item-container'],article,div[class*='DivItemContainer']" } ] },
    { id: "amazon", hosts: "(^|\\.)amazon\\.[a-z.]+$",
      hide: [ { cat: "widgets", reason: "Rufus AI", css: "#nav-rufus-disco,[id^='rufus'],#product-summary,[data-feature-name*='rufus']" } ] },
    { id: "linkedin", hosts: "(^|\\.)linkedin\\.com$",
      hide: [ { cat: "widgets", reason: "LinkedIn AI", css: "[data-test-ai-assistant],.ai-assistant-entrypoint" } ] },
    { id: "generic", hosts: ".*",
      containers: "article,[role='article'],li"
    }
  ]
};
require("fs").writeFileSync(__dirname + "/rules.json", JSON.stringify(rules));
console.log("wrote rules.json v" + rules.version);
