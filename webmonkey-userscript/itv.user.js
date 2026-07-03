// ==UserScript==
// @name         itv
// @description  Improve site usability. Watch videos in external player.
// @version      1.0.3
// @match        *://*.itv.com/*
// @icon         https://assets.fe.itv.com/images/brands/itvx/itvx-favicon-blue-144x144px.png
// @run-at       document-end
// @grant        unsafeWindow
// @homepage     https://github.com/warren-bank/crx-itv/tree/webmonkey-userscript/es5
// @supportURL   https://github.com/warren-bank/crx-itv/issues
// @downloadURL  https://github.com/warren-bank/crx-itv/raw/webmonkey-userscript/es5/webmonkey-userscript/itv.user.js
// @updateURL    https://github.com/warren-bank/crx-itv/raw/webmonkey-userscript/es5/webmonkey-userscript/itv.user.js
// @namespace    warren-bank
// @author       Warren Bank
// @copyright    Warren Bank
// ==/UserScript==

// ----------------------------------------------------------------------------- user options

var user_options = {
  "common": {
    "debug_verbosity":              0,  // 0 = silent. 1 = console log. 2 = window alert. 3 = window alert + conditional breakpoint.
    "init_delay_ms":                5000,
    "sort_newest_first":            false
  },
  "webmonkey": {
    "post_intent_redirect_to_url":  null  // "about:blank"
  },
  "greasemonkey": {
    "redirect_to_webcast_reloaded": true,
    "force_http":                   true,
    "force_https":                  false
  }
}

// ----------------------------------------------------------------------------- constants

var constants = {
  "button_attributes": {
    "api_url":                      "x-api-url",

    "video_url":                    "x-video-url",
    "video_type":                   "x-video-type",
    "caption_url":                  "x-caption-url",
    "referer_url":                  "x-referer-url",
    "drm_scheme":                   "x-drm-scheme",
    "drm_server":                   "x-drm-server"
  },
  "img_urls": {
    "base_webcast_reloaded_icons":  "https://github.com/warren-bank/crx-webcast-reloaded/raw/gh-pages/chrome_extension/2-release/popup/img/"
  }
}

var strings = {
  "button_download_video":          "Get Video URL",
  "button_start_video":             "Start Video",
  "episode_labels": {
    "title":                        "title:",
    "summary":                      "summary:",
    "duration":                     "duration:",
    "expires":                      "expires:",
    "video": {
      "format":                     "format:",
      "drm":                        "drm:"
    }
  },
  "livetv_epg_toggle_button": {
    "show":                         "Show",
    "hide":                         "Hide"
  },
  "livetv_channel_labels": {
    "epg": {
      "series_title":               "Series Title:",
      "episode_title":              "Episode Title:",
      "episode_summary":            "Summary:",
      "duration_date_range":        "Time:",
      "duration":                   "Duration:"
    }
  }
}

// ----------------------------------------------------------------------------- state

var state = {
  series:     {}, // {title, summary}
  episodes:   [], // [{id, api_url, title, summary, duration, expires}]
  current_episode_index: -1,

  livetv_channels: [], // [{id, api_url, name, epg: [{series_title, episode_title, episode_summary, duration_date_range, duration}]}]
  current_livetv_channel_index: -1
}

// ----------------------------------------------------------------------------- CSP

// add support for CSP 'Trusted Type' assignment
var add_default_trusted_type_policy = function() {
  if (typeof unsafeWindow.trustedTypes !== 'undefined') {
    try {
      var passthrough_policy = function(string) {return string}

      unsafeWindow.trustedTypes.createPolicy('default', {
          createHTML:      passthrough_policy,
          createScript:    passthrough_policy,
          createScriptURL: passthrough_policy
      })
    }
    catch(e) {}
  }
}

// ----------------------------------------------------------------------------- debug logger

var debug = function(msg, breakpoint) {
  if (!user_options.common.debug_verbosity) return

  if (msg) {
    if (typeof msg !== 'string')
      msg = JSON.stringify(msg, null, 2)

    switch(user_options.common.debug_verbosity) {
      case 1:
        console.log(msg)
        break
      case 2:
      case 3:
        unsafeWindow.alert(msg)
        break
    }
  }

  if (breakpoint && (user_options.common.debug_verbosity > 2))
    debugger;
}

// ----------------------------------------------------------------------------- helpers (xhr)

var serialize_xhr_body_object = function(data) {
  if (typeof data === 'string')
    return data

  if (!(data instanceof Object))
    return null

  var body = []
  var keys = Object.keys(data)
  var key, val
  for (var i=0; i < keys.length; i++) {
    key = keys[i]
    val = data[key]
    val = unsafeWindow.encodeURIComponent(val)

    body.push(key + '=' + val)
  }
  body = body.join('&')
  return body
}

var download_text = function(url, headers, data, withCredentials, callback) {
  if (data) {
    if (!headers)
      headers = {}
    if (!headers['content-type'])
      headers['content-type'] = 'application/x-www-form-urlencoded'

    switch(headers['content-type'].toLowerCase()) {
      case 'application/json':
        data = JSON.stringify(data)
        break

      case 'application/x-www-form-urlencoded':
      default:
        data = serialize_xhr_body_object(data)
        break
    }
  }

  var xhr    = new unsafeWindow.XMLHttpRequest()
  var method = data ? 'POST' : 'GET'

  xhr.open(method, url, true, null, null)
  xhr.withCredentials = !!withCredentials

  if (headers && (typeof headers === 'object')) {
    var keys = Object.keys(headers)
    var key, val
    for (var i=0; i < keys.length; i++) {
      key = keys[i]
      val = headers[key]
      xhr.setRequestHeader(key, val)
    }
  }

  xhr.onload = function(e) {
    if (xhr.readyState === 4) {
      if ((xhr.status >= 200) && (xhr.status < 300)) {
        callback(null, xhr.responseText)
        return
      }
    }
    callback(new Error())
  }

  xhr.onerror = function(e) {
    callback(new Error())
  }

  if (data)
    xhr.send(data)
  else
    xhr.send()
}

var download_json = function(url, headers, data, withCredentials, callback) {
  if (!headers)
    headers = {}
  if (!headers.accept)
    headers.accept = 'application/json'

  download_text(url, headers, data, withCredentials, function(error, text){
    try {
      if (error)
        callback(error)
      else
        callback(null, JSON.parse(text))
    }
    catch(e) {}
  })
}

// ----------------------------------------------------------------------------- helpers

var make_element = function(elementName, html, text) {
  var el = unsafeWindow.document.createElement(elementName)

  if (html)
    el.innerHTML = html

  if (text)
    el.textContent = text

  return el
}

var make_span = function(text) {return make_element('span', null, text)}
var make_h4   = function(text) {return make_element('h4',   null, text)}

var add_style_element = function(css) {
  if (!css) return

  var head = unsafeWindow.document.getElementsByTagName('head')[0]
  if (!head) return

  if ('function' === (typeof css))
    css = css()
  if (Array.isArray(css))
    css = css.join("\n")

  head.appendChild(
    make_element('style', null, css)
  )
}

var empty_element = function(el, html, text) {
  while (el.childNodes.length)
    el.removeChild(el.childNodes[0])

  if (html)
    el.innerHTML = html

  if (text)
    el.textContent = text

  return el
}

var append_tr = function(tr, td, colspan) {
  if (Array.isArray(td))
    tr.push('<tr><td>' + td.join('</td><td>') + '</td></tr>')
  else if ((typeof colspan === 'number') && (colspan > 1))
    tr.push('<tr><td colspan="' + colspan + '">' + td + '</td></tr>')
  else
    tr.push('<tr><td>' + td + '</td></tr>')
}

var cancel_event = function(event) {
  event.stopPropagation();event.stopImmediatePropagation();event.preventDefault();event.returnValue=false;
}

// https://stackoverflow.com/a/66696162
var convertSecondsToReadableString = function(seconds) {
  seconds = seconds || 0
  seconds = Number(seconds)
  seconds = Math.abs(seconds)

  var seconds_per_minute = 60
  var seconds_per_hour   = seconds_per_minute * 60
  var seconds_per_day    = seconds_per_hour * 24
  var seconds_per_year   = seconds_per_day * 365

  var y = Math.floor(seconds / seconds_per_year)
  var d = Math.floor((seconds % seconds_per_year) / seconds_per_day)
  var h = Math.floor((seconds % seconds_per_day)  / seconds_per_hour)
  var m = Math.floor((seconds % seconds_per_hour) / seconds_per_minute)
  var s = Math.floor( seconds % seconds_per_minute)

  var parts = []

  if (y > 0) {
    parts.push(y + ' year' + (y > 1 ? 's' : ''))
  }
  if (d > 0) {
    parts.push(d + ' day' + (d > 1 ? 's' : ''))
  }
  if (h > 0) {
    parts.push(h + ' hour' + (h > 1 ? 's' : ''))
  }
  if (m > 0) {
    parts.push(m + ' minute' + (m > 1 ? 's' : ''))
  }
  if (s > 0) {
    parts.push(s + ' second' + (s > 1 ? 's' : ''))
  }
  return parts.join(', ')
}

var convertDateRangeToReadableString = function(start_date, end_date) {
  start_date = new Date(start_date)
  end_date   = new Date(end_date)

  var parts = {
    start_date: start_date.toLocaleDateString(),
    start_time: start_date.toLocaleTimeString(),

    end_date:   end_date.toLocaleDateString(),
    end_time:   end_date.toLocaleTimeString()
  }

  var range = parts.start_date + ' ' + parts.start_time + ' - ' + ((parts.end_date !== parts.start_date) ? (parts.end_date + ' ') : '') + parts.end_time
  return range
}

var find_needle = function(data) {
  var index_start, index_stop

  index_start = data.haystack.indexOf(data.needle)
  if (index_start >= 0) {
    index_start += data.needle.length
    index_stop = data.haystack.indexOf(data.tail, index_start)
    if ((index_stop === -1) && !data.strict) {
      index_stop = data.haystack.length
    }
    if (index_stop >= index_start) {
      return data.haystack.substring(index_start, index_stop)
    }
  }
  return null
}

// ----------------------------------------------------------------------------- URL links to tools on Webcast Reloaded website

var get_webcast_reloaded_url = function(video_data, force_http, force_https) {
  force_http  = (typeof force_http  === 'boolean') ? force_http  : user_options.greasemonkey.force_http
  force_https = (typeof force_https === 'boolean') ? force_https : user_options.greasemonkey.force_https

  var encoded_video_url, encoded_caption_url, encoded_referer_url, encoded_drm_url, webcast_reloaded_base, webcast_reloaded_url

  encoded_video_url      = encodeURIComponent(encodeURIComponent(btoa(video_data.video_url)))
  encoded_caption_url    = video_data.caption_url ? encodeURIComponent(encodeURIComponent(btoa(video_data.caption_url))) : null
  video_data.referer_url = video_data.referer_url ? video_data.referer_url : unsafeWindow.location.href
  encoded_referer_url    = encodeURIComponent(encodeURIComponent(btoa(video_data.referer_url)))
  encoded_drm_url        = (video_data.drm.scheme && video_data.drm.server) ? encodeURIComponent(encodeURIComponent(btoa(video_data.drm.scheme + '|' + video_data.drm.server))) : null

  webcast_reloaded_base = {
    "https": "https://warren-bank.github.io/crx-webcast-reloaded/external_website/index.html",
    "http":  "http://webcast-reloaded.frii.site/index.html"
  }

  webcast_reloaded_base = (force_http)
                            ? webcast_reloaded_base.http
                            : (force_https)
                               ? webcast_reloaded_base.https
                               : (video_data.video_url.toLowerCase().indexOf('http:') === 0)
                                  ? webcast_reloaded_base.http
                                  : webcast_reloaded_base.https

  webcast_reloaded_url  = webcast_reloaded_base    + '#/watch/'    + encoded_video_url
                            + (encoded_caption_url ? ('/subtitle/' + encoded_caption_url) : '')
                            + (encoded_referer_url ? ('/referer/'  + encoded_referer_url) : '')
                            + (encoded_drm_url     ? ('/drm/'      + encoded_drm_url) : '')

  return webcast_reloaded_url
}

var get_webcast_reloaded_url_chromecast_sender = function(video_data) {
  return get_webcast_reloaded_url(video_data, /* force_http= */ null, /* force_https= */ null).replace('/index.html', '/chromecast_sender.html')
}

var get_webcast_reloaded_url_airplay_sender = function(video_data) {
  return get_webcast_reloaded_url(video_data, /* force_http= */ true, /* force_https= */ false).replace('/index.html', '/airplay_sender.es5.html')
}

var get_webcast_reloaded_url_proxy = function(video_data) {
  return get_webcast_reloaded_url(video_data, /* force_http= */ true, /* force_https= */ false).replace('/index.html', '/proxy.html')
}

var get_webcast_reloaded_urls = function(video_data) {
  return {
    "index":             get_webcast_reloaded_url(                  video_data),
    "chromecast_sender": get_webcast_reloaded_url_chromecast_sender(video_data),
    "airplay_sender":    get_webcast_reloaded_url_airplay_sender(   video_data),
    "proxy":             get_webcast_reloaded_url_proxy(            video_data)
  }
}

// ----------------------------------------------------------------------------- URL handlers

var redirect_to_url = function(url) {
  if (!url) return

  if (typeof GM_loadUrl === 'function') {
    if (typeof GM_resolveUrl === 'function')
      url = GM_resolveUrl(url, unsafeWindow.location.href) || url

    GM_loadUrl(url, 'Referer', unsafeWindow.location.href)
  }
  else {
    try {
      unsafeWindow.top.location = url
    }
    catch(e) {
      unsafeWindow.window.location = url
    }
  }
}

var process_webmonkey_post_intent_redirect_to_url = function() {
  var url = null

  if (typeof user_options.webmonkey.post_intent_redirect_to_url === 'string')
    url = user_options.webmonkey.post_intent_redirect_to_url

  if (typeof user_options.webmonkey.post_intent_redirect_to_url === 'function')
    url = user_options.webmonkey.post_intent_redirect_to_url()

  if (typeof url === 'string')
    redirect_to_url(url)
}

// -----------------------------------------------------------------------------

var process_video_data = function(data) {
  if (!data.video_url) return

  if (!data.referer_url)
    data.referer_url = unsafeWindow.location.href

  if (typeof GM_startIntent === 'function') {
    // running in Android-WebMonkey: open Intent chooser

    if (!data.video_type)
      data.video_type = ''

    var args = [
      /* action = */ 'android.intent.action.VIEW',
      /* data   = */ data.video_url,
      /* type   = */ data.video_type
    ]

    // extras:
    if (data.caption_url) {
      args.push('textUrl')
      args.push(data.caption_url)
    }
    if (data.referer_url) {
      args.push('referUrl')
      args.push(data.referer_url)
    }
    if (data.drm.scheme) {
      args.push('drmScheme')
      args.push(data.drm.scheme)
    }
    if (data.drm.server) {
      args.push('drmUrl')
      args.push(data.drm.server)
    }
    if (data.drm.headers && (typeof data.drm.headers === 'object')) {
      var drm_header_keys, drm_header_key, drm_header_val

      drm_header_keys = Object.keys(data.drm.headers)
      for (var i=0; i < drm_header_keys.length; i++) {
        drm_header_key = drm_header_keys[i]
        drm_header_val = data.drm.headers[drm_header_key]

        args.push('drmHeader')
        args.push(drm_header_key + ': ' + drm_header_val)
      }
    }

    GM_startIntent.apply(this, args)
    process_webmonkey_post_intent_redirect_to_url()
    return true
  }
  else if (user_options.greasemonkey.redirect_to_webcast_reloaded) {
    // running in standard web browser: redirect URL to top-level tool on Webcast Reloaded website

    redirect_to_url(
      get_webcast_reloaded_url(data)
    )
    return true
  }
  else {
    return false
  }
}

var process_hls_data = function(data) {
  data.video_type = 'application/x-mpegurl'
  process_video_data(data)
}

var process_dash_data = function(data) {
  data.video_type = 'application/dash+xml'
  process_video_data(data)
}

// -----------------------------------------------------------------------------

var process_video_url = function(video_url, video_type, caption_url, referer_url, drm_scheme, drm_server) {
  var data = {
    video_url:   video_url   || null,
    video_type:  video_type  || null,
    caption_url: caption_url || null,
    referer_url: referer_url || null,
    drm: {
      scheme:    drm_scheme,
      server:    drm_server,
      headers:   null
    }
  }

  process_video_data(data)
}

var process_hls_url = function(hls_url, caption_url, referer_url, drm_scheme, drm_server) {
  process_video_url(/* video_url= */ hls_url, /* video_type= */ 'application/x-mpegurl', caption_url, referer_url, drm_scheme, drm_server)
}

var process_dash_url = function(dash_url, caption_url, referer_url, drm_scheme, drm_server) {
  process_video_url(/* video_url= */ dash_url, /* video_type= */ 'application/dash+xml', caption_url, referer_url, drm_scheme, drm_server)
}

// ----------------------------------------------------------------------------- API: common utilities

var scrape_dom_data = function() {
  var json, data

  try {
    json = unsafeWindow.document.querySelector('script#__NEXT_DATA__').textContent
    data = JSON.parse(json)

    if (
      !data || (typeof data !== 'object') ||
      !data.props || (typeof data.props !== 'object') ||
      !data.props.pageProps || (typeof data.props.pageProps !== 'object')
    ) throw 0

    data = data.props.pageProps

    // series or film
    if (
      data.programme && (typeof data.programme === 'object') &&
      Array.isArray(data.seriesList) && data.seriesList.length
    ) {
      data = {
        live:       false,
        programme:  data.programme,
        seriesList: data.seriesList
      }
    }

    else if (
      Array.isArray(data.channels) && data.channels.length
    ) {
      data = {
        live:     true,
        channels: data.channels
      }
    }

    else {
      throw 0
    }

    if (!data.live) {
      data.film = (data.programme.numberOfAvailableSeries === 0)
    }
  }
  catch(e) {
    data = null
  }
  return data
}

// ----------------------------------------------------------------------------- API: extract VOD (series and films)

var process_series_media_items = function(dom_data, series_id, episode_id, callback) {
  // sanity check
  if (!dom_data.programme.encodedProgrammeId || (typeof dom_data.programme.encodedProgrammeId !== 'object') || !dom_data.programme.encodedProgrammeId.letterA || (dom_data.programme.encodedProgrammeId.letterA !== series_id)) return

  state.series = {
    title:   dom_data.programme.title,
    summary: dom_data.programme.longDescription || dom_data.programme.description
  }

  state.episodes = normalize_series_media_items(
    find_series_media_items(dom_data.seriesList)
  )

  debug('episodes: ' + typeof state.episodes + ' (' + ((state.episodes === null) ? 'null' : state.episodes.length) + ')')
  if (!state.episodes || !state.episodes.length) return

  if (user_options.common.sort_newest_first)
    state.episodes.reverse()

  if (episode_id) {
    for (var i=0; i < state.episodes.length; i++) {
      if (state.episodes[i].id === episode_id) {
        state.current_episode_index = i
        break
      }
    }
  }
  else if (dom_data.film || (state.episodes.length === 1)) {
    state.current_episode_index = 0
  }

  callback()
}

var find_series_media_items = function(seasons) {
  var episodes = []
  var season, episode

  for (var i=0; i < seasons.length; i++) {
    season = seasons[i]

    if (!season || (typeof season !== 'object') || !Array.isArray(season.titles) || !season.titles.length) continue

    for (var j=0; j < season.titles.length; j++) {
      episode = season.titles[j]

      episodes.push(episode)
    }
  }

  return episodes
}

var normalize_series_media_items = function(old_items) {
  if (!Array.isArray(old_items)) return null

  return old_items.map(function(old_item) {
    if (!old_item || (typeof old_item !== 'object')) return null

    var episode_id = (old_item.encodedEpisodeId && (typeof old_item.encodedEpisodeId === 'object') && old_item.encodedEpisodeId.letterA)
      ? old_item.encodedEpisodeId.letterA
      : null

    var expires = old_item.availabilityUntil
      ? convertSecondsToReadableString(
          Math.floor(
            (new Date(old_item.availabilityUntil)).getTime() / 1000
          )
        )
      : null

    var title = old_item.episodeTitle
    if (old_item.contentInfo) {
      title = title
        ? ('[' + old_item.contentInfo + '] ' + title)
        : old_item.contentInfo
    }
    if (!title && old_item.heroCtaLabel && (typeof old_item.heroCtaLabel === 'object') && old_item.heroCtaLabel.episodeLabel) {
      title = old_item.heroCtaLabel.episodeLabel
    }

    var new_item = {
      id:       episode_id,
      api_url:  old_item.playlistUrl,
      title:    title,
      summary:  old_item.longDescription || old_item.description,
      duration: old_item.duration,
      expires:  expires
    }

    return new_item
  })
  .filter(function(new_item) {
    return !!(new_item && new_item.api_url && new_item.title)
  })
}

// ----------------------------------------------------------------------------- API: extract live tv channels and EPG

var process_livetv_guide = function(dom_data, channel_id, callback) {
  state.series = {
    title:   'Live TV Channels',
    summary: null
  }

  state.livetv_channels = normalize_livetv_channels_list(
    dom_data.channels
  )

  debug('live tv channels: ' + typeof state.livetv_channels + ' (' + ((state.livetv_channels === null) ? 'null' : state.livetv_channels.length) + ')')
  if (!state.livetv_channels || !state.livetv_channels.length) return

  if (channel_id) {
    for (var i=0; i < state.livetv_channels.length; i++) {
      if (state.livetv_channels[i].id === channel_id) {
        state.current_livetv_channel_index = i
        break
      }
    }
  }

  callback()
}

var normalize_livetv_channels_list = function(all_channels) {
  if (!Array.isArray(all_channels) || !all_channels.length) return null

  return all_channels.map(function(channel) {
    if (!channel || (typeof channel !== 'object') || !channel.playlistUrl || !channel.name) return null

    var epg = null

    if (
      channel.slots && (typeof channel.slots === 'object') &&
      channel.slots.now  && (typeof channel.slots.now  === 'object') && channel.slots.now.displayTitle  && channel.slots.now.start  && channel.slots.now.end &&
      channel.slots.next && (typeof channel.slots.next === 'object') && channel.slots.next.displayTitle && channel.slots.next.start && channel.slots.next.end
    ) {
      epg = [
        channel.slots.now,
        channel.slots.next
      ]
      .map(function(broadcast) {
        var duration_date_range, duration

        duration_date_range = (broadcast.start && broadcast.end)
          ? convertDateRangeToReadableString(broadcast.start, broadcast.end)
          : null

        duration = broadcast.duration
          ? convertSecondsToReadableString(
              broadcast.duration
            )
          : null

        return {
          series_title:        broadcast.displayTitle,
          episode_title:       broadcast.detailedDisplayTitle,
          episode_summary:     broadcast.shortSynopsis,
          duration_date_range: duration_date_range,
          duration:            duration
        }
      })
    }

    return {
      id:      channel.id || channel.slug,
      api_url: channel.playlistUrl,
      name:    channel.name,
      epg:     epg
    }
  })
  .filter(function(channel) {
    return !!channel
  })
}

// ----------------------------------------------------------------------------- API: download video sources for episode in series

var download_video_sources = function(api_url, callback) {
  var data = {
    "client": {
      "id": "browser",
      "service": "itv.x"
    },
    "device": {
      "manufacturer": "Firefox",
      "deviceGroup": "dotcom"
    },
    "user": {
      "token": ""
    },
    "variantAvailability": {
      "player": "dash",
      "featureset": {
        "min": ["mpeg-dash", "widevine", "hd", "outband-webvtt"],
        "max": ["mpeg-dash", "widevine", "hd", "outband-webvtt"]
      },
      "platformTag": "dotcom",
      "drm": {
        "system": "widevine",
        "maxSupported": "L3"
      }
    }
  }

  download_json(
    /* url= */ api_url,
    /* headers= */ {
      "content-type": "application/json",
      "accept":       "application/vnd.itv.online.playlist.sim.v3+json"
    },
    /* data= */ data,
    /* withCredentials= */ false,
    function(error, api_media_data) {
      if (error) return

      normalize_api_media_data(api_media_data, callback)
    }
  )
}

var normalize_api_media_data = function(api_media_data, callback) {
  if (
    !api_media_data || (typeof api_media_data !== 'object') ||
    (api_media_data.StatusCode !== 200) ||
    !api_media_data.Playlist || (typeof api_media_data.Playlist !== 'object') ||
    !api_media_data.Playlist.Video || (typeof api_media_data.Playlist.Video !== 'object')
  ) return

  api_media_data = api_media_data.Playlist.Video

  var is_vod  = Array.isArray(api_media_data.MediaFiles) && api_media_data.MediaFiles.length
  var is_live = Array.isArray(api_media_data.VideoLocations) && api_media_data.VideoLocations.length

  if (!is_vod && !is_live) return

  var caption_url = null
  if (is_vod && Array.isArray(api_media_data.Subtitles) && api_media_data.Subtitles.length) {
    api_media_data.Subtitles = api_media_data.Subtitles.filter(function(txtrack) {
      return !!(txtrack && (typeof txtrack === 'object') && txtrack.Href)
    })

    if (api_media_data.Subtitles.length) {
      caption_url = api_media_data.Subtitles[0].Href
    }
  }

  var video_sources = []
  var i, base_url, src, has_drm, video_data

  if (is_vod) {
    base_url = api_media_data.Base || ''

    for (i=0; i < api_media_data.MediaFiles.length; i++) {
      src = api_media_data.MediaFiles[i]
      if (!src || (typeof src !== 'object') || !src.Href) continue

      has_drm = !!src.KeyServiceUrl

      video_data = {
        video_url:   base_url + src.Href,
        video_type:  'application/dash+xml',
        caption_url: caption_url,
        referer_url: null,
        drm: {
          scheme:    (has_drm ? 'widevine' : null),
          server:    (has_drm ? src.KeyServiceUrl : null),
          headers:   null
        }
      }

      video_sources.push(video_data)
    }
  }

  if (is_live) {
    for (i=0; i < api_media_data.VideoLocations.length; i++) {
      src = api_media_data.VideoLocations[i]
      if (!src || (typeof src !== 'object') || !src.Url) continue

      has_drm = !!src.KeyServiceUrl

      video_data = {
        video_url:   src.Url,
        video_type:  'application/dash+xml',
        caption_url: caption_url,
        referer_url: null,
        drm: {
          scheme:    (has_drm ? 'widevine' : null),
          server:    (has_drm ? src.KeyServiceUrl : null),
          headers:   null
        }
      }

      video_sources.push(video_data)
    }
  }

  callback(video_sources)
}

// ----------------------------------------------------------------------------- DOM: static skeleton

var reinitialize_dom = function() {
  add_default_trusted_type_policy()

  unsafeWindow.document.close()
  unsafeWindow.document.open()
  unsafeWindow.document.write('')
  unsafeWindow.document.close()

  empty_element(unsafeWindow.document.getElementsByTagName('head')[0])
  empty_element(unsafeWindow.document.body)

  add_style_element(function(){
    return [
      // --------------------------------------------------- reset

      'body {',
      '  margin: 0;',
      '  padding: 0;',
      '  font-family: serif;',
      '  font-size: 16px;',
      '  background-color: #fff !important;',
      '  overflow: auto !important;',
      '}',

      // --------------------------------------------------- declutter

      // hide: "cookie choices" modal overlay
      'body > #cassie-widget {',
      '  display: none !important;',
      '}',

      // --------------------------------------------------- series title

      'body > div > h2 {',
      '  display: block;',
      '  margin: 0;',
      '  padding: 0.5em;',
      '  font-size: 22px;',
      '  text-align: center;',
      '  background-color: #ccc;',
      '}',

      // --------------------------------------------------- series description

      'body > div > div {',
      '  padding: 0.5em;',
      '  font-size: 18px;',
      '}',

      // --------------------------------------------------- list of videos: episodes in series, or individual movie or episode

      'body > div > ul {',
      '  list-style: none;',
      '  margin: 0;',
      '  padding: 0;',
      '  padding-left: 1em;',
      '  padding-bottom: 1em;',
      '}',

      'body > div > ul > li {',
      '  list-style: none;',
      '  margin-top: 0.5em;',
      '  border-top: 1px solid #999;',
      '  padding-top: 0.5em;',
      '}',

      'body > div > ul > li > table td:first-child {',
      '  font-style: italic;',
      '  padding-right: 1em;',
      '}',

      'body > div > ul > li > blockquote {',
      '  display: block;',
      '  background-color: #eee;',
      '  padding: 0.5em 1em;',
      '  margin: 0;',
      '}',

      'body > div > ul > li > div {',
      '  margin: 0.75em 0;',
      '}',

      // --------------------------------------------------- drm

      'body > div > ul > li > div > table {',
      '  width: 100%;',
      '  border-collapse: collapse;',
      '}',

      'body > div > ul > li > div > table tr > td:first-child + td {',
      '  width: 100%;',
      '}',

      'body > div > ul > li > div > table tr > td {',
      '  border-top: 1px solid #999;',
      '  padding: 0.5em 0;',
      '}',

      'body > div > ul > li > div > table tr:first-child > td {',
      '  border-top-style: none;',
      '}',

      'body > div > ul > li > div > table button {',
      '  white-space: nowrap;',
      '}',

      'body > div > ul > li > div > table tr > td:last-child > div.icons-container {',
      '}',

      // --------------------------------------------------- links to tools on Webcast Reloaded website

      'body > div > ul > li div.icons-container {',
      '  display: block;',
      '  position: relative;',
      '  z-index: 1;',
      '  float: right;',
      '  margin: 0.5em;',
      '  width: 60px;',
      '  height: 60px;',
      '  max-height: 60px;',
      '  vertical-align: top;',
      '  background-color: #d7ecf5;',
      '  border: 1px solid #000;',
      '  border-radius: 14px;',
      '}',

      'body > div > ul > li div.icons-container > a.chromecast,',
      'body > div > ul > li div.icons-container > a.chromecast > img,',
      'body > div > ul > li div.icons-container > a.airplay,',
      'body > div > ul > li div.icons-container > a.airplay > img,',
      'body > div > ul > li div.icons-container > a.proxy,',
      'body > div > ul > li div.icons-container > a.proxy > img,',
      'body > div > ul > li div.icons-container > a.video-link,',
      'body > div > ul > li div.icons-container > a.video-link > img {',
      '  display: block;',
      '  width: 25px;',
      '  height: 25px;',
      '}',

      'body > div > ul > li div.icons-container > a.chromecast,',
      'body > div > ul > li div.icons-container > a.airplay,',
      'body > div > ul > li div.icons-container > a.proxy,',
      'body > div > ul > li div.icons-container > a.video-link {',
      '  position: absolute;',
      '  z-index: 1;',
      '  text-decoration: none;',
      '}',

      'body > div > ul > li div.icons-container > a.chromecast,',
      'body > div > ul > li div.icons-container > a.airplay {',
      '  top: 0;',
      '}',
      'body > div > ul > li div.icons-container > a.proxy,',
      'body > div > ul > li div.icons-container > a.video-link {',
      '  bottom: 0;',
      '}',

      'body > div > ul > li div.icons-container > a.chromecast,',
      'body > div > ul > li div.icons-container > a.proxy {',
      '  left: 0;',
      '}',
      'body > div > ul > li div.icons-container > a.airplay,',
      'body > div > ul > li div.icons-container > a.video-link {',
      '  right: 0;',
      '}',
      'body > div > ul > li div.icons-container > a.airplay + a.video-link {',
      '  right: 17px; /* (60 - 25)/2 to center when there is no proxy icon */',
      '}',

      // --------------------------------------------------- live tv channel

      'body > div > ul > li > blockquote + div + div > table.livetv-channel tr {',
      '  vertical-align: top;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel tr > td {',
      '  padding: 0;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel tr > td:first-child {',
      '  white-space: nowrap;',
      '  padding-right: 1em;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel tr > td > h3 {',
      '  padding: 0;',
      '  margin: 0;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel table {',
      '  width: 100%;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel table table tr > td {',
      '  border-style: none;',
      '  padding: 0.25em 0;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel div.livetv-epg-toggle-container {',
      '  transition: height  0.5s linear;',
      '  overflow-y: hidden !important;',
      '  height: auto !important;',
      '}',

      'body > div > ul > li > blockquote + div + div > table.livetv-channel div.livetv-epg-toggle-container.toggle-hide {',
      '  height: 0px !important;',
      '}',

      ''
    ]
  })

  var div, ul, li
  var i

  div = make_element('div')
  ul  = make_element('ul')
  div.appendChild(ul)

  if (state.series.title) {
    div.insertBefore(
      make_element('h2', null, state.series.title),
      ul
    )
  }

  if (state.series.summary) {
    div.insertBefore(
      make_element('div', null, state.series.summary),
      ul
    )
  }

  for (i=0; i < state.episodes.length; i++) {
    li = make_episode_listitem_element(
      state.episodes[i]
    )

    if (li) {
      ul.appendChild(li)

      if (i === state.current_episode_index) {
        li.querySelector(':scope button[' + constants.button_attributes.api_url + ']').click()
      }
    }
  }

  for (i=0; i < state.livetv_channels.length; i++) {
    li = make_livetv_channel_listitem_element(
      state.livetv_channels[i]
    )

    if (li) {
      ul.appendChild(li)

      if (i === state.current_livetv_channel_index) {
        li.querySelector(':scope button[' + constants.button_attributes.api_url + ']').click()
      }
    }
  }

  unsafeWindow.document.body.appendChild(div)
}

// ----------------------------------------------------------------------------- DOM: <li> for episode in show series

var make_episode_listitem_element = function(episode) {
  // const {api_url, title, summary, duration, expires} = episode

  var tr, html, li, div_dynamic

  tr = []
  if (episode.title)
    append_tr(tr, [strings.episode_labels.title, episode.title])
  if (episode.duration)
    append_tr(tr, [strings.episode_labels.duration, episode.duration])
  if (episode.expires)
    append_tr(tr, [strings.episode_labels.expires, episode.expires])
  if (episode.summary)
    append_tr(tr, strings.episode_labels.summary, 2)

  html = [
    '<table>' + tr.join("\n") + '</table>',
    '<blockquote>' + episode.summary + '</blockquote>',
    '<div></div>'
  ]

  li = make_element('li', html.join("\n"))

  div_dynamic = li.querySelector(':scope > div')
  div_dynamic.appendChild(
    make_download_video_button(episode.api_url)
  )

  return li
}

var make_download_video_button = function(api_url) {
  var button = make_element('button')

  button.setAttribute(constants.button_attributes.api_url, api_url)
  button.textContent = strings.button_download_video
  button.addEventListener("click", onclick_download_video_button)

  return button
}

var onclick_download_video_button = function(event) {
  cancel_event(event)

  var button, div_dynamic, api_url

  button = event.target
  if (!button) return

  div_dynamic = button.parentElement
  if (!div_dynamic) return

  api_url = button.getAttribute(constants.button_attributes.api_url)
  if (!api_url) return

  download_video_sources(api_url, function(video_sources) {
    add_video_sources_to_listitem_element(div_dynamic, video_sources)
  })
}

var add_video_sources_to_listitem_element = function(div_dynamic, video_sources) {
  // video_sources is array of video_data: {video_url, video_type, caption_url, referer_url, drm: {scheme, server, headers}}

  var tr, video_data, video_summary, td_button, td_icons, div_icons, a_icons, a_icon
  var i

  tr = []
  for (i=0; i < video_sources.length; i++) {
    video_data = video_sources[i]

    video_summary  = '<ul>'
    video_summary += '  <li>' + strings.episode_labels.video.format + ' ' + video_data.video_type + '</li>'
    video_summary += '  <li>' + strings.episode_labels.video.drm    + ' ' + (video_data.drm.scheme || 'none') + '</li>'
    video_summary += '</ul>'

    append_tr(tr, ['', video_summary, '']) // col 1: button. col 3: icons.
  }
  empty_element(div_dynamic, '<table>' + tr.join("\n") + '</table>')

  tr = div_dynamic.querySelectorAll(':scope > table tr')

  for (i=0; i < tr.length; i++) {
    video_data = video_sources[i]

    td_button = tr[i].querySelector(':scope > td:first-child')
    td_icons  = tr[i].querySelector(':scope > td:last-child')

    add_start_video_button(/* block_element= */ td_button, video_data)

    if (video_data.drm.scheme) {
      div_icons = make_webcast_reloaded_div(video_data)

      a_icons = {
        real:    {},  // order: chromecast, airplay, [proxy], video-link
        ordered: []
      }

      a_icons.real.airplay    = div_icons.querySelector('a.airplay')
      a_icons.real.direct_hls = div_icons.querySelector('a.video-link')

      a_icon = a_icons.real.direct_hls.cloneNode(/* deep= */ true)
      a_icon.className = 'chromecast'
      a_icons.ordered.push(a_icon)

      a_icon = a_icons.real.direct_hls.cloneNode(/* deep= */ true)
      a_icon.className = 'airplay'
      a_icon.setAttribute('href',  video_data.drm.server)
      a_icon.setAttribute('title', 'direct link to ' + video_data.drm.scheme + ' drm server')
      a_icons.ordered.push(a_icon)

      a_icon = a_icons.real.airplay.cloneNode(/* deep= */ true)
      a_icon.className = 'video-link'
      a_icons.ordered.push(a_icon)

      empty_element(div_icons)

      for (var j=0; j < a_icons.ordered.length; j++) {
        a_icon = a_icons.ordered[j]

        div_icons.appendChild(a_icon)
      }
      a_icons = null

      td_icons.appendChild(div_icons)
    }
    else {
      insert_webcast_reloaded_div(/* block_element= */ td_icons, video_data)
    }
  }
}

var add_start_video_button = function(block_element, video_data) {
  var new_button = make_start_video_button(video_data)

  block_element.appendChild(new_button)
}

var make_start_video_button = function(video_data) {
  var button = make_element('button')

  button.setAttribute(constants.button_attributes.video_url,   video_data.video_url   || '')
  button.setAttribute(constants.button_attributes.video_type,  video_data.video_type  || '')
  button.setAttribute(constants.button_attributes.caption_url, video_data.caption_url || '')
  button.setAttribute(constants.button_attributes.referer_url, video_data.referer_url || '')
  button.setAttribute(constants.button_attributes.drm_scheme,  video_data.drm.scheme  || '')
  button.setAttribute(constants.button_attributes.drm_server,  video_data.drm.server  || '')
  button.textContent = strings.button_start_video
  button.addEventListener("click", onclick_start_video_button)

  return button
}

var onclick_start_video_button = function(event) {
  cancel_event(event)

  var button      = event.target
  var video_url   = button.getAttribute(constants.button_attributes.video_url)
  var video_type  = button.getAttribute(constants.button_attributes.video_type)
  var caption_url = button.getAttribute(constants.button_attributes.caption_url)
  var referer_url = button.getAttribute(constants.button_attributes.referer_url)
  var drm_scheme  = button.getAttribute(constants.button_attributes.drm_scheme)
  var drm_server  = button.getAttribute(constants.button_attributes.drm_server)

  if (video_url)
    process_video_url(video_url, video_type, caption_url, referer_url, drm_scheme, drm_server)
}

// -----------------------------------------------------------------------------

var insert_webcast_reloaded_div = function(block_element, video_data) {
  var webcast_reloaded_div = make_webcast_reloaded_div(video_data)

  block_element.appendChild(webcast_reloaded_div)
}

var make_webcast_reloaded_div = function(video_data) {
  var webcast_reloaded_urls = get_webcast_reloaded_urls(video_data)

  var div = make_element('div')

  var html = [
    '<a target="_blank" class="chromecast" href="' + webcast_reloaded_urls.chromecast_sender   + '" title="Chromecast Sender"><img src="'       + constants.img_urls.base_webcast_reloaded_icons + 'chromecast.png"></a>',
    '<a target="_blank" class="airplay" href="'    + webcast_reloaded_urls.airplay_sender      + '" title="ExoAirPlayer Sender"><img src="'     + constants.img_urls.base_webcast_reloaded_icons + 'airplay.png"></a>',
    '<a target="_blank" class="proxy" href="'      + webcast_reloaded_urls.proxy               + '" title="HLS-Proxy Configuration"><img src="' + constants.img_urls.base_webcast_reloaded_icons + 'proxy.png"></a>',
    '<a target="_blank" class="video-link" href="' + video_data.video_url                      + '" title="direct link to video"><img src="'    + constants.img_urls.base_webcast_reloaded_icons + 'video_link.png"></a>'
  ]

  div.setAttribute('class', 'icons-container')
  div.innerHTML = html.join("\n")

  return div
}

// ----------------------------------------------------------------------------- DOM: <li> for live tv channel

var make_livetv_channel_listitem_element = function(channel) {
  // const {api_url, name, epg} = channel

  var tr, epg_html, html, li, div_dynamic, livetv_epg_toggle_button

  tr = []
  if (Array.isArray(channel.epg) && channel.epg.length) {
    for (var i=0; i < channel.epg.length; i++) {
      append_tr(
        tr,
        add_epg_to_livetv_channel_listitem_element(channel.epg[i])
      )
    }
  }

  epg_html = []
  if (tr.length) {
    epg_html = [
      '<div>',
        '<table class="livetv-channel">',
          '<tr>',
            '<td></td>',
            '<td>',
              '<h3>EPG:</h3>',
              '<button class="livetv-epg-toggle-button">' + strings.livetv_epg_toggle_button.show + '</button>',
              '<div class="livetv-epg-toggle-container toggle-hide">',
                '<table class="livetv-epg">',
                  '<tr><td></td></tr>',
                  tr.join("\n"),
                '</table>',
              '</div>',
            '</td>',
          '</tr>',
        '</table>',
      '</div>'
    ]
  }

  html = [
    '<blockquote>' + channel.name + '</blockquote>',
    '<div></div>',
    epg_html.join("\n")
  ]

  li = make_element('li', html.join("\n"))

  epg_html = null
  html = null

  div_dynamic = li.querySelector(':scope > blockquote + div')
  div_dynamic.appendChild(
    make_download_video_button(channel.api_url)
  )

  livetv_epg_toggle_button = li.querySelector(':scope button.livetv-epg-toggle-button')
  if (livetv_epg_toggle_button) {
    livetv_epg_toggle_button.addEventListener("click", onclick_livetv_epg_toggle_button)
  }

  return li
}

var add_epg_to_livetv_channel_listitem_element = function(epg) {
  // const {series_title, episode_title, episode_summary, duration_date_range, duration} = epg

  var tr = []
  if (epg.duration_date_range)
    append_tr(tr, [strings.livetv_channel_labels.epg.duration_date_range, epg.duration_date_range])
  if (epg.duration)
    append_tr(tr, [strings.livetv_channel_labels.epg.duration, epg.duration])
  if (epg.series_title)
    append_tr(tr, [strings.livetv_channel_labels.epg.series_title, epg.series_title])
  if (epg.episode_title)
    append_tr(tr, [strings.livetv_channel_labels.epg.episode_title, epg.episode_title])
  if (epg.episode_summary)
    append_tr(tr, [strings.livetv_channel_labels.epg.episode_summary, epg.episode_summary])

  return '<table>' + tr.join("\n") + '</table>'
}

var onclick_livetv_epg_toggle_button = function(event) {
  cancel_event(event)

  var className = 'toggle-hide'
  var button, div_dynamic

  button = event.target
  if (!button) return

  div_dynamic = button.nextElementSibling
  if (!div_dynamic || !div_dynamic.classList.contains('livetv-epg-toggle-container')) return

  if (div_dynamic.classList.contains(className)) {
    // toggle: hide => show
    div_dynamic.classList.remove(className)
    button.textContent = strings.livetv_epg_toggle_button.hide
  }
  else {
    // toggle: show => hide
    div_dynamic.classList.add(className)
    button.textContent = strings.livetv_epg_toggle_button.show
  }
}

// ----------------------------------------------------------------------------- bootstrap: live tv

var page_init_livetv = function(dom_data) {
  var path = unsafeWindow.location.pathname
  var qs   = unsafeWindow.location.search
  var channelId

  if (path === '/watch') {
    channelId = find_needle({
      haystack: qs,
      needle:   'channel=',
      tail:     '&',
      strict:   false
    })
    debug('channelId: ' + channelId)

    process_livetv_guide(dom_data, channelId, reinitialize_dom)
  }
}

// ----------------------------------------------------------------------------- bootstrap: shows

var page_init_shows = function(dom_data) {
  var path = unsafeWindow.location.pathname
  var seriesId, episodeId

  if ((path.length < 2) || (path[0] !== '/')) return
  path = path.split('/')
  /*
    [0] = ''
    [1] = 'watch'
    [2] = $titleSlug
    [3] = $seriesId
    [4] = $episodeId (optional)
  */

  if ((path.length < 4) || (path[1] !== 'watch')) return

  seriesId = path[3]
  debug('seriesId: ' + seriesId)

  episodeId = (path.length >= 5) ? path[4] : null
  debug('episodeId: ' + episodeId)

  process_series_media_items(dom_data, seriesId, episodeId, reinitialize_dom)
}

// ----------------------------------------------------------------------------- bootstrap

var page_init = function() {
  debug('initializing..', true)

  var dom_data = scrape_dom_data()
  if (!dom_data) return

  if (dom_data.live)
    page_init_livetv(dom_data)
  else
    page_init_shows(dom_data)
}

if (user_options.common.init_delay_ms)
  unsafeWindow.setTimeout(page_init, user_options.common.init_delay_ms)
else
  page_init()
