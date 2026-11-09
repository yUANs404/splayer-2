/**
 * AI 播放器适配层（渲染层）
 * 接收主进程下发的复杂播放指令，调用 PlayerController 原有能力执行，
 * 并把真实执行结果回执给主进程——AI 的理解结果与实际执行结果在此分离
 */
import { usePlayerController } from "@/core/player/PlayerController";
import { useLocalStore } from "@/stores";
import { fuzzySearch } from "@/utils/helper";
import { getConverter } from "@/utils/opencc";
import type { AiCommand, AiSettings } from "@/types/shared";
import { AI_IPC_CHANNELS } from "@/types/shared";
import type { SongType } from "@/types/main";

/** 繁→简转换器（whisper 可能输出繁体） */
let t2sConverter: ((text: string) => string) | null = null;

/** 文本归一化：繁转简、去空白与常见标点、转小写 */
const normalize = (text: string): string => {
  const simplified = t2sConverter ? t2sConverter(text) : text;
  return simplified
    .replace(/[\s《》【】[\]()（）"'“”、，。！？!?\-_.·~*&#@]+/g, "")
    .toLowerCase();
};

/** 回执执行结果给主进程 */
const reportResult = (success: boolean, message: string): void => {
  window.electron?.ipcRenderer.send(AI_IPC_CHANNELS.REPORT_RESULT, { success, message });
};

/** 读取 AI 设置（用于歧义确认策略） */
const loadSettings = async (): Promise<AiSettings | null> => {
  try {
    return await window.ai.getSettings();
  } catch {
    return null;
  }
};

/** 取歌曲的歌手显示名（artists 兼容 string 与数组两种形态） */
const artistNames = (song: SongType): string => {
  const artists = song.artists;
  if (typeof artists === "string") return artists;
  return (artists || []).map((a) => a.name).join("/");
};

/** 候选歌曲按匹配质量排序（歌名精确 > 歌名前缀 > 模糊） */
const rankBySongName = (candidates: SongType[], songName: string): SongType[] => {
  const q = normalize(songName);
  return [...candidates].sort((a, b) => {
    const na = normalize(a.name || "");
    const nb = normalize(b.name || "");
    const score = (n: string) => (n === q ? 0 : n.startsWith(q) ? 1 : 2);
    return score(na) - score(nb);
  });
};

/** 按歌手过滤 */
const filterByArtist = (songs: SongType[], artist?: string): SongType[] => {
  if (!artist) return songs;
  const a = normalize(artist);
  return songs.filter((s) => {
    const artists = s.artists;
    if (typeof artists === "string") {
      const an = normalize(artists);
      return Boolean(an) && (an.includes(a) || a.includes(an));
    }
    return (artists || []).some((ar) => {
      const an = normalize(ar.name || "");
      return an && (an.includes(a) || a.includes(an));
    });
  });
};

/** 播放一组歌曲（第一首为最匹配项） */
const playSongs = (player: ReturnType<typeof usePlayerController>, songs: SongType[]): void => {
  void player.updatePlayList(songs, undefined, undefined, { showTip: true, play: true });
};

/** 播放歌曲意图 */
const handlePlayMusic = async (
  player: ReturnType<typeof usePlayerController>,
  parameters: AiCommand["parameters"],
): Promise<void> => {
  const localStore = useLocalStore();
  if (!localStore.localSongs.length) {
    reportResult(false, "本地曲库为空，请先扫描音乐目录");
    return;
  }
  const songName = parameters.song_name || "";
  const artist = parameters.artist;
  const songs1 = localStore.localSongs;
  // 主进程曲库终裁附带 id 时直接精确命中，避免任何二次猜测
  if (parameters.track_id) {
    const byId = songs1.find((s) => String(s.id) === String(parameters.track_id));
    if (byId) {
      playSongs(player, [byId]);
      reportResult(true, `正在播放《${byId.name}》`);
      return;
    }
  }
  const direct = filterByArtist(songs1, artist).filter(
    (s) => normalize(s.name) === normalize(songName),
  );
  let candidates = direct;
  if (!candidates.length) {
    const fuzzy = fuzzySearch(songName, songs1);
    candidates = filterByArtist(fuzzy, artist);
  }
  if (!candidates.length) {
    reportResult(false, `曲库中没有找到${artist ? `${artist}的` : ""}《${songName}》`);
    return;
  }
  candidates = rankBySongName(candidates, songName);
  if (candidates.length > 1) {
    const settings = await loadSettings();
    if (!settings?.autoPlayBestMatch) {
      // 上报候选，由 AI 面板展示确认按钮
      const options = candidates.slice(0, 3).map((s) => ({
        id: String(s.id),
        title: s.name,
        artist: artistNames(s),
      }));
      window.electron?.ipcRenderer.send(AI_IPC_CHANNELS.AMBIGUOUS, {
        message: `找到 ${candidates.length} 个匹配，请选择`,
        candidates: options,
      });
      return;
    }
  }
  playSongs(player, candidates);
  reportResult(true, `正在播放《${candidates[0].name}》`);
};

/** 播放歌手意图：全部歌曲入列，随机挑一首开始（用户偏好：不只放第一首） */
const handlePlayArtist = async (
  player: ReturnType<typeof usePlayerController>,
  parameters: AiCommand["parameters"],
): Promise<void> => {
  const localStore = useLocalStore();
  const songs = localStore.localSongs;
  if (!songs.length) {
    reportResult(false, "本地曲库为空，请先扫描音乐目录");
    return;
  }
  const matched = filterByArtist(songs, parameters.artist || "");
  if (!matched.length) {
    reportResult(false, `曲库中没有找到歌手「${parameters.artist}」的歌曲`);
    return;
  }
  const start = matched[Math.floor(Math.random() * matched.length)];
  void player.updatePlayList(matched, start, undefined, { showTip: true, play: true });
  reportResult(
    true,
    `已把 ${parameters.artist} 的 ${matched.length} 首歌曲加入列表，随机播放《${start.name}》`,
  );
};

/** 播放歌单意图 */
const handlePlayPlaylist = async (
  player: ReturnType<typeof usePlayerController>,
  parameters: AiCommand["parameters"],
): Promise<void> => {
  const localStore = useLocalStore();
  const playlists = localStore.localPlaylists || [];
  const name = parameters.name || "";
  const matched = playlists.filter((p) => normalize(p.name).includes(normalize(name)));
  if (!matched.length) {
    reportResult(false, `没有找到歌单「${name}」`);
    return;
  }
  const playlist = matched[0];
  const songsMap = new Map<string, SongType>(localStore.localSongs.map((s) => [String(s.id), s]));
  const songs = (playlist.songs || [])
    .map((id) => songsMap.get(id))
    .filter((s): s is SongType => Boolean(s));
  if (!songs.length) {
    reportResult(false, `歌单「${playlist.name}」为空`);
    return;
  }
  playSongs(player, songs);
  reportResult(true, `正在播放歌单「${playlist.name}」的 ${songs.length} 首歌曲`);
};

/** 搜索音乐意图 */
const handleSearchMusic = async (parameters: AiCommand["parameters"]): Promise<void> => {
  const localStore = useLocalStore();
  const keyword = parameters.keyword || "";
  const found = fuzzySearch(keyword, localStore.localSongs);
  reportResult(true, found.length ? `找到 ${found.length} 首相关歌曲` : `没有找到与「${keyword}」相关的歌曲`);
};

/** 推荐音乐意图（按心情关键词匹配，无匹配时随机播放） */
const handleRecommendMusic = async (
  player: ReturnType<typeof usePlayerController>,
  parameters: AiCommand["parameters"],
): Promise<void> => {
  const localStore = useLocalStore();
  const songs = localStore.localSongs;
  if (!songs.length) {
    reportResult(false, "本地曲库为空，请先扫描音乐目录");
    return;
  }
  const mood = parameters.mood || parameters.scene || "";
  const matched = mood ? fuzzySearch(mood, songs) : [];
  if (matched.length) {
    playSongs(player, matched);
    reportResult(true, `为你找到 ${matched.length} 首适合「${mood}」的歌曲`);
    return;
  }
  // 无直接匹配时随机播放，营造氛围
  const shuffled = [...songs].sort(() => Math.random() - 0.5).slice(0, 20);
  playSongs(player, shuffled);
  reportResult(true, `没有直接匹配「${mood}」的歌曲，已为你随机播放`);
};

/** 分发执行 AI 播放指令 */
const handleCommand = async (command: AiCommand): Promise<void> => {
  const player = usePlayerController();
  const { intent, parameters } = command;
  try {
    switch (intent) {
      case "play_music":
        await handlePlayMusic(player, parameters);
        break;
      case "play_artist":
        await handlePlayArtist(player, parameters);
        break;
      case "play_playlist":
        await handlePlayPlaylist(player, parameters);
        break;
      case "search_music":
        await handleSearchMusic(parameters);
        break;
      case "recommend_music":
        await handleRecommendMusic(player, parameters);
        break;
      case "set_volume":
        if (typeof parameters.volume === "number") {
          player.setVolume(Math.max(0, Math.min(parameters.volume, 100)) / 100);
          reportResult(true, `音量已调整到 ${parameters.volume}%`);
        }
        break;
      case "shuffle":
        void player.toggleShuffle(parameters.enable ? "on" : "off");
        reportResult(true, parameters.enable ? "已开启随机播放" : "已关闭随机播放");
        break;
      case "repeat":
        if (parameters.mode) {
          player.toggleRepeat(parameters.mode);
          reportResult(true, "播放模式已更新");
        }
        break;
      case "stop":
        await player.pause();
        reportResult(true, "已停止播放");
        break;
      default:
        reportResult(false, `暂不支持的指令: ${intent}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportResult(false, `执行失败：${message}`);
  }
};

/** 初始化 AI 播放器适配层（随 initIpc 一次） */
export const initAiPlayerAdapter = (): void => {
  if (!window.ai) return;
  getConverter("t2s")
    .then((c) => {
      t2sConverter = c;
    })
    .catch(() => undefined);
  window.ai.onCommand((command) => {
    void handleCommand(command);
  });
};
