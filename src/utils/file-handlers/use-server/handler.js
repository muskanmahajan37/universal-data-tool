// @flow weak
// NOTE: for unit tests you need to change the following line to...
// import rfc6902 from "rfc6902"
import * as rfc6902 from "rfc6902"
import bent from "bent"
import getHumanReadableLog from "./get-human-readable-log.js"
import applySeamlessPatch from "./apply-seamless-patch.js"
import hash from "./server-hash.js"

class CollaborationHandler {
  serverUrl = "http://localhost:6003"
  getJSON = (url, payload, opts) => {}
  postJSON = (url, payload, opts) => {}
  patchJSON = (url, payload, opts) => {}
  userName = "anonymous"

  sessionId = null
  state = null
  version = null

  constructor({ serverUrl, userName }) {
    this.serverUrl = serverUrl
    this.getJSON = bent("json", "GET", serverUrl)
    this.postJSON = bent("json", "POST", serverUrl)
    this.patchJSON = bent("json", "PATCH", serverUrl)
    this.userName =
      userName || `anonymous_${Math.random().toString(36).slice(2, 6)}`
  }

  async createSession(initialContent) {
    // Send an initial udt object without samples (to avoid 5mb payload limit)
    const response = await this.postJSON("/api/session", {
      udt: { ...initialContent, samples: [] },
    })
    this.sessionId = response.short_id
    this.version = response.version

    // Populate the samples in increments of 100
    let lastState = { ...initialContent, samples: [] }
    for (let i = 0; i < initialContent.samples.length; i += 40) {
      let nextState = {
        ...initialContent,
        samples: initialContent.samples.slice(0, i + 40),
      }
      const patch = rfc6902.createPatch(lastState, nextState)
      const { latestVersion } = await this.patchJSON(
        `/api/session/${encodeURIComponent(this.sessionId)}`,
        {
          patch,
          userName: this.userName,
        }
      )
      lastState = nextState
      this.version = latestVersion
    }

    this.state = initialContent
  }

  async getLatestState() {
    try {
      let res
      try {
        res = await this.getJSON(
          `/api/session/${encodeURIComponent(this.sessionId)}`
        )
        throw new Error("always use sample range for now")
      } catch (e) {
        // Try to fetch in small increments
        const samples = []
        for (let i = 0; ; i += 50) {
          res = await this.getJSON(
            `/api/session/${encodeURIComponent(
              this.sessionId
            )}?sample_range=${i}-${i + 50}`
          )
          if (!res.sampleRange) throw e
          if (res.udt_json.samples.length === 0) break
          samples.push(...res.udt_json.samples)
        }
        res = { ...res, udt_json: { ...res.udt_json, samples } }
        console.log({ res })
        if (hash(res.udt_json) !== res.hashOfLatestState) {
          console.log("hashes didn't match when combining sample ranges")
        }
      }
      return {
        state: res.udt_json,
        version: res.version,
      }
    } catch (e) {
      throw new Error(
        `error getting session "${this.sessionId}": ${e.toString()}`
      )
    }
  }

  async updateToLatestState() {
    const { state, version } = await this.getLatestState()
    this.state = state
    this.version = version
  }

  async joinSession(sessionId) {
    this.sessionId = sessionId
    await this.updateToLatestState()
  }

  async applyLatestPatches() {
    const {
      patch,
      hashOfLatestState,
      latestVersion,
      changeLog,
    } = await this.getJSON(
      `/api/session/${encodeURIComponent(this.sessionId)}/diffs?since=${
        this.version
      }`
    )

    if (patch.length === 0 || latestVersion === this.version) {
      return null
    }

    const humanReadableLog = getHumanReadableLog(changeLog)

    let newState = applySeamlessPatch(this.state, patch)

    if (hash(newState) !== hashOfLatestState) {
      console.error("new state with patches applied didn't match latest state")
      await this.updateToLatestState()
      return { patch, changeLog: humanReadableLog }
    }

    this.state = newState
    this.version = latestVersion
    return { patch, changeLog: humanReadableLog }
  }

  async sendPatchIfChanged(newState) {
    const patch = rfc6902.createPatch(this.state, newState)
    if (patch.length === 0) return null

    const { hashOfLatestState, latestVersion } = await this.patchJSON(
      `/api/session/${encodeURIComponent(this.sessionId)}`,
      {
        patch,
        userName: this.userName,
      }
    )

    if (hash(newState) !== hashOfLatestState) {
      console.error(
        "after patch, hashes were not equal! getting latest version from server..."
      )
      await this.updateToLatestState()
      return this
    }

    this.state = newState
    this.version = latestVersion
    return this
  }
}

export default CollaborationHandler
