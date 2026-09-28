// Injected into YouTube Music's MAIN world. Keep dependencies inside this function.
export async function playerOperation(command) {
  const element = document.querySelector("ytmusic-player-queue#queue");
  const store = element?.queue?.store?.store;
  const player = document.querySelector("#movie_player");
  if (!store?.getState || !element?.dispatch) {
    throw Error(
      "YouTube Music queue is not ready. Open a song and its Up next tab.",
    );
  }
  function renderer(item) {
    return (
      item.playlistPanelVideoRenderer ||
      item.playlistPanelVideoWrapperRenderer?.primaryRenderer
        ?.playlistPanelVideoRenderer
    );
  }
  function text(value) {
    return (
      value?.simpleText || value?.runs?.map((run) => run.text).join("") || ""
    );
  }
  function read() {
    const state = store.getState();
    if (
      state.castStatus?.castConnectionData?.castConnectionState === "CONNECTED"
    )
      throw Error("Stop casting before hosting a Jam");
    if (!Array.isArray(state.queue.items))
      throw Error("Unsupported YouTube Music queue model");
    return {
      items: state.queue.items.map((item) => {
        const data = renderer(item);
        if (!data?.videoId)
          throw Error("The queue contains an unsupported row");
        const remove = data.menu?.menuRenderer?.items?.find(
          (item) =>
            item.menuServiceItemRenderer?.serviceEndpoint
              ?.removeFromQueueEndpoint,
        );
        return {
          nativeId:
            remove?.menuServiceItemRenderer.serviceEndpoint
              .removeFromQueueEndpoint.itemId,
          videoId: data.videoId,
          title: text(data.title),
          artist: text(data.shortBylineText),
        };
      }),
      index: state.queue.selectedItemIndex,
      playing: player?.getPlayerState?.() === 1,
      position: (player?.getCurrentTime?.() || 0) * 1000,
      duration: (player?.getDuration?.() || 0) * 1000,
    };
  }
  async function confirm(predicate) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (predicate(read())) return read();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error(
      "YouTube Music did not confirm the change. Outcome unknown; refresh before retrying.",
    );
  }
  if (command.op === "READ") return read();
  if (command.op === "PAUSE") {
    player?.pauseVideo?.();
    return { ok: true };
  }
  const before = read();
  if (
    command.expectedVideos &&
    before.items.map((row) => row.videoId).join(",") !==
      command.expectedVideos.join(",")
  ) {
    throw Error("Queue changed before the edit; refresh and retry");
  }
  if (command.op === "ADD" || command.op === "PLAY_NEXT") {
    if (!/^[A-Za-z0-9_-]{11}$/.test(command.videoId))
      throw Error("Invalid video ID");
    const app = document.querySelector("ytmusic-app");
    if (!app?.networkManager?.fetch)
      throw Error("YouTube Music queue service is unavailable");
    // YouTube Music resolves its own playable renderer and menu endpoints.
    const response = await app.networkManager.fetch("/music/get_queue", {
      queueContextParams: store.getState().queue.queueContextParams,
      queueInsertPosition:
        command.op === "PLAY_NEXT"
          ? "INSERT_AFTER_CURRENT_VIDEO"
          : "INSERT_AT_END",
      videoIds: [command.videoId],
    });
    const items = response.queueDatas
      ?.map((entry) => entry.content)
      .filter(Boolean);
    if (items?.length !== 1 || renderer(items[0])?.videoId !== command.videoId)
      throw Error("YouTube Music could not resolve that song");
    const current = read();
    if (current.items.length >= 500)
      throw Error("Queue exceeds 500-item Jam limit");
    const index =
      command.op === "PLAY_NEXT"
        ? Math.max(0, current.index + 1)
        : current.items.length;
    element.dispatch({
      type: "ADD_ITEMS",
      payload: {
        items,
        index,
        nextQueueItemId: store.getState().queue.nextQueueItemId,
        shouldAssignIds: true,
        shuffleEnabled: false,
      },
    });
    return confirm(
      (state) =>
        state.items.length === current.items.length + 1 &&
        state.items[index]?.videoId === command.videoId,
    );
  }
  if (command.op === "MOVE") {
    const expected = before.items.map((row) => row.videoId);
    expected.splice(
      command.toIndex,
      0,
      expected.splice(command.fromIndex, 1)[0],
    );
    element.dispatch({
      type: "MOVE_ITEM",
      payload: { fromIndex: command.fromIndex, toIndex: command.toIndex },
    });
    return confirm(
      (state) =>
        state.items.map((row) => row.videoId).join(",") === expected.join(","),
    );
  }
  if (command.op === "REMOVE") {
    const expected = before.items.map((row) => row.videoId);
    expected.splice(command.index, 1);
    element.dispatch({ type: "REMOVE_ITEM", payload: command.index });
    return confirm(
      (state) =>
        state.items.map((row) => row.videoId).join(",") === expected.join(","),
    );
  }
  if (command.op === "PLAY") {
    if (before.items[command.index]?.videoId !== command.videoId)
      throw Error("Queue changed before playback");
    if (
      before.index !== command.index ||
      player?.getVideoData?.().video_id !== command.videoId
    ) {
      element.dispatch({ type: "SET_INDEX", payload: command.index });
    }
    if (command.playing) player?.playVideo?.();
    else player?.pauseVideo?.();
    return confirm(
      (state) =>
        state.index === command.index && state.playing === command.playing,
    );
  }
  if (command.op === "SEEK") {
    if (player?.getVideoData?.().video_id !== command.videoId)
      throw Error("Current track changed");
    player.seekTo(command.position / 1000, true);
    return confirm(
      (state) => Math.abs(state.position - command.position) < 2500,
    );
  }
  throw Error("Unsupported player operation");
}
