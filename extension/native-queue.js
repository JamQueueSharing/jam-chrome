// Runs in the page world. Only public queue state crosses into this adapter.
export function nativeQueueIntegration(message) {
  const key = "__morpheJamQueue";
  let integration = window[key];
  if (message.state?.role !== "Participant") {
    integration?.restore();
    delete window[key];
    return { commands: [] };
  }
  const element = document.querySelector("ytmusic-player-queue#queue");
  const store = element?.queue?.store?.store;
  if (!store?.getState || !store?.dispatch)
    throw Error("Open YouTube Music Up next to connect the native queue");
  if (integration && integration.store !== store) {
    integration.restore();
    integration = null;
  }
  if (!integration) {
    const originalGetState = store.getState;
    const originalDispatch = store.dispatch;
    const originalAutostart = element.queue.blockPlaybackAutostart;
    integration = {
      store,
      commands: [],
      snapshot: null,
      queueView: null,
      connected: false,
      savedQueue: originalGetState().queue,
    };

    function enqueue(command) {
      if (!integration.connected) {
        integration.error = "Disconnected; wait for the host before editing";
        return;
      }
      if (integration.commands.length >= 32) {
        integration.error = "Too many pending queue actions";
        return;
      }
      integration.commands.push({
        ...command,
        revision: integration.snapshot?.revision,
      });
    }
    function displayedRows() {
      return [
        ...(integration.snapshot?.items || []).map((row) => ({
          ...row,
          lane: 0,
        })),
        ...(integration.snapshot?.autoplay || []).map((row) => ({
          ...row,
          lane: 1,
        })),
      ];
    }
    function playRow(row) {
      if (row)
        enqueue({
          op: "PLAY",
          item: row.id,
          videoId: row.videoId,
          lane: row.lane,
        });
    }
    const getState = () => {
      const state = originalGetState();
      return integration.queueView
        ? { ...state, queue: integration.queueView }
        : state;
    };
    const dispatch = (action) => {
      const rows = displayedRows();
      if (action.type === "MOVE_ITEM") {
        const item = rows[action.payload?.fromIndex];
        const target = rows[action.payload?.toIndex];
        if (item && target && item.lane === target.lane)
          enqueue({
            op: "MOVE",
            item: item.id,
            target: target.id,
            lane: item.lane,
          });
        else
          integration.error = "Tracks can only move within their queue section";
        return action;
      }
      if (action.type === "REMOVE_ITEM") {
        const item = rows[action.payload];
        if (item) enqueue({ op: "REMOVE", item: item.id, lane: item.lane });
        return action;
      }
      if (action.type === "SET_INDEX") {
        playRow(rows[action.payload]);
        return action;
      }
      if (action.type === "ADD_ITEMS") {
        const items = action.payload?.items || [];
        const data =
          items[0]?.playlistPanelVideoRenderer ||
          items[0]?.playlistPanelVideoWrapperRenderer?.primaryRenderer
            ?.playlistPanelVideoRenderer;
        if (items.length === 1 && data?.videoId) {
          const current = rows.findIndex((row) => row.current);
          enqueue({
            op: action.payload.index === current + 1 ? "PLAY_NEXT" : "ADD",
            videoId: data.videoId,
          });
        } else
          integration.error = "Add one song at a time while joined to a Jam";
        return action;
      }
      if (
        [
          "CLEAR",
          "SET_ITEMS",
          "SET_QUEUE",
          "SET_AUTOMIX_ITEMS",
          "SHUFFLE",
          "SET_SHUFFLE_ENABLED",
        ].includes(action.type)
      ) {
        integration.error =
          "Leave Jam before replacing or shuffling your local queue";
        return action;
      }
      return originalDispatch(action);
    };
    function stopLocalAudio(event) {
      if (event.target instanceof HTMLMediaElement) event.target.pause();
    }
    function interceptClick(event) {
      const path = event.composedPath();
      const menuItem = path.find(
        (node) => node?.tagName === "YTMUSIC-MENU-SERVICE-ITEM-RENDERER",
      );
      const endpoint = menuItem?.data?.serviceEndpoint;
      const add = endpoint?.queueAddEndpoint;
      if (add) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const videoId = add.queueTarget?.videoId;
        if (videoId)
          enqueue({
            op:
              add.queueInsertPosition === "INSERT_AFTER_CURRENT_VIDEO"
                ? "PLAY_NEXT"
                : "ADD",
            videoId,
          });
        else integration.error = "Add one song at a time while joined to a Jam";
        return;
      }
      const remove = endpoint?.removeFromQueueEndpoint;
      if (remove) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const rows = displayedRows();
        const row =
          rows.find((row) => `jam:${row.id}` === remove.itemId) ||
          rows[integration.menuIndex];
        if (row && row.videoId === remove.videoId)
          enqueue({ op: "REMOVE", item: row.id, lane: row.lane });
        return;
      }
      const queueRow = path.find(
        (node) => node?.tagName === "YTMUSIC-PLAYER-QUEUE-ITEM",
      );
      const isMenu = path.some(
        (node) => node?.tagName === "YTMUSIC-MENU-RENDERER",
      );
      if (queueRow && isMenu) {
        const data = queueRow.data?.playlistPanelVideoRenderer || queueRow.data;
        integration.menuIndex = displayedRows().findIndex(
          (row) => row.id === data?.morpheJamId,
        );
      }
      if (queueRow && !isMenu) {
        const data = queueRow.data?.playlistPanelVideoRenderer || queueRow.data;
        const row = displayedRows().find((row) => row.id === data?.morpheJamId);
        if (row) {
          event.preventDefault();
          event.stopImmediatePropagation();
          playRow(row);
        }
        return;
      }
      const control = path.find((node) =>
        node?.matches?.(".next-button, .previous-button, #play-pause-button"),
      );
      if (control?.closest("ytmusic-player-bar")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (control.matches(".next-button")) enqueue({ op: "SKIP_NEXT" });
        else if (control.matches(".previous-button"))
          enqueue({ op: "SKIP_PREVIOUS" });
        else {
          const row = displayedRows().find((row) => row.current);
          if (row)
            enqueue({
              op: "PLAY",
              item: row.id,
              videoId: row.videoId,
              playing: !integration.snapshot?.clock?.playing,
            });
        }
      }
    }
    store.getState = getState;
    store.dispatch = dispatch;
    element.queue.blockPlaybackAutostart = true;
    document.addEventListener("click", interceptClick, true);
    document.addEventListener("play", stopLocalAudio, true);
    document.querySelector("#movie_player")?.pauseVideo?.();
    integration.restore = () => {
      document.removeEventListener("click", interceptClick, true);
      document.removeEventListener("play", stopLocalAudio, true);
      if (store.getState === getState) store.getState = originalGetState;
      if (store.dispatch === dispatch) store.dispatch = originalDispatch;
      element.queue.blockPlaybackAutostart = originalAutostart;
      originalDispatch({ type: "MORPHE_JAM_REFRESH" });
    };
    window[key] = integration;
  }
  integration.connected = message.state.connected;
  const snapshot = message.state.snapshot;
  if (snapshot && integration.snapshot?.revision !== snapshot.revision) {
    function queueItem(row, index, lane) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(row.videoId))
        throw Error("Invalid video ID in host queue");
      return {
        playlistPanelVideoRenderer: {
          videoId: row.videoId,
          morpheJamId: row.id,
          morpheJamLane: lane,
          title: {
            runs: [{ text: String(row.title || row.videoId).slice(0, 200) }],
          },
          shortBylineText: {
            runs: [{ text: String(row.artist || "").slice(0, 200) }],
          },
          longBylineText: {
            runs: [{ text: String(row.artist || "").slice(0, 200) }],
          },
          thumbnail: {
            thumbnails: [
              {
                url: `https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg`,
                width: 480,
                height: 360,
              },
            ],
          },
          selected: !!row.current,
          canReorder: true,
          navigationEndpoint: {
            watchEndpoint: { videoId: row.videoId, index },
          },
          menu: {
            menuRenderer: {
              items: [
                {
                  menuServiceItemRenderer: {
                    text: { runs: [{ text: "Remove from queue" }] },
                    icon: { iconType: "REMOVE" },
                    serviceEndpoint: {
                      removeFromQueueEndpoint: {
                        videoId: row.videoId,
                        itemId: `jam:${row.id}`,
                      },
                    },
                  },
                },
              ],
              accessibility: { accessibilityData: { label: "Queue actions" } },
            },
          },
        },
      };
    }
    const main = snapshot.items || [];
    const autoplay = snapshot.autoplay || [];
    if (main.length + autoplay.length > 500)
      throw Error("Host queue exceeds the 500-item limit");
    const items = [
      ...main.map((row, index) => queueItem(row, index, 0)),
      ...autoplay.map((row, index) => queueItem(row, main.length + index, 1)),
    ];
    integration.snapshot = snapshot;
    integration.queueView = {
      ...integration.savedQueue,
      items,
      automixItems: [],
      selectedItemIndex: Math.max(
        0,
        main.findIndex((row) => row.current),
      ),
      isInfinite: false,
      isGenerating: false,
      autoplay: false,
      shuffleEnabled: false,
      nextQueueItemId: items.length,
      continuation: null,
    };
    // Subscribers read our view; the underlying local queue remains untouched.
    integration.store.dispatch({ type: "MORPHE_JAM_REFRESH" });
  } else if (snapshot) integration.snapshot = snapshot;
  const commands = integration.commands.splice(0);
  const error = integration.error;
  integration.error = "";
  return { commands, error };
}
