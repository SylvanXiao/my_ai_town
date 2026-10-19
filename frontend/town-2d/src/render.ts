import { WeatherLayer } from './weather'
import type { ServerMsg } from 'town-shared/protocol'
import { position as spatialPosition, type Spatial } from 'town-shared/spatial'
import { savedAppearance, defaultAppearance } from 'town-shared/props/appearances'
import type { Appearance, PropView } from 'town-shared/props/types'
import type { Atlas, Topology } from 'town-shared/mapDocument'
import type {
  AvatarPrompt,
  ResidentEntry,
  ScreenBox,
  WalkStep,
  WalkTarget,
} from 'town-shared/gameMap'
import type { AvatarState } from 'town-shared/avatar/types'
import { buildStaticMap, type PlacedProp } from './map/staticLayers'
import { groundOf, paintGround, type Ground } from './map/pixel/terrain'
import type { DecorPlan } from './map/decor'
import type { HdScene } from './map/hd2d/scene'
import type { VillagerPlacement } from './map/hd2d/villagers'
import { PropPositions } from './map/propPositions'
import { RoomCovers } from './map/rooms'
import { MapCamera } from './map/camera'
import { standUpright, uprightRatio } from './map/upright'
import { ThoughtBubbles } from './map/bubbles'
import { ResidentLayer } from './map/residents'
import { PromptLayer } from './map/prompts'
import { propArtwork } from './map/propArt'
import type { PropPlacement } from './map/hd2d/props'
import { avatarLookOptions, VILLAGER_HALF, VILLAGER_HEIGHT } from './map/hd2d/villagerSprite'
import { PROP_HALF, WalkRoutes } from './map/route'
import { LEGACY_UNITS_PER_METRE, OUTDOOR_SPACE } from './map/grid'
import { village, type MapTheme } from './map/themes'
import { el } from 'town-shared/svg'
import type { Quality } from 'town-shared/quality'
// 地图装配：静态图层、人物/气泡、镜头各自拥有状态；公共观察接口保持不变。

export interface TownMapOptions {
  atlas: Atlas
  topology: Topology
  container: HTMLElement
  appearanceFor?: (id: string, definition: string) => Appearance
  /** 有它才把运行期道具坐标交给小镇服务保存 */
  persistence?: { townId: string; mapHash: string }
  /** 有三维数据时人物位置按米换算，SVG 单位每米取自数据本身 */
  spatial?: Spatial
  /** 非致命问题（坐标保存失败）通知调用方显示 */
  notify?: (message: string) => void
  /** 地图风格，缺省是原作山水小镇 */
  theme?: MapTheme
  /** 调用方已经算好的地面（建镇预览先拿它画缩略图）；不给就在这里算 */
  ground?: Ground
}

export class TownMap {
  readonly weatherSupported = true
  /** 平面图的天气层：只在立体场景起不来、退回平面像素地面时才有 */
  private weather?: WeatherLayer
  /** 最近一份名册，退回平面图时交给天气层 */
  private lastRoster?: Extract<ServerMsg, { type: 'roster' }>
  readonly avatarSupported = true
  readonly avatarLooks = avatarLookOptions
  private avatarActive = false
  private zoom = 1
  setAvatarActive(active: boolean) {
    this.avatarActive = active
    this.svg.classList.toggle('avatar-mode', active)
    this.applyMarkerScale()
    if (!active) this.prompts.clear()
  }
  /** 化身在场或立体场景接手时，标记、文字与提示标签按缩放倍率反向缩放：整图时和观察模式一样大，
   *  放大后沿用人物尺寸比例，名字额外限制为不超过 16 屏幕像素，避免遮住近景。平面观察模式不缩放。 */
  private applyMarkerScale() {
    const scaled = this.avatarActive || !!this.hd
    this.svg.classList.toggle('scaled-labels', scaled)
    const screenScale = Math.abs(this.svg.getScreenCTM()?.a || 1)
    // 名字字号 54 个地图单位：化身模式按人物比例缩小，立体场景固定为 16 屏幕像素
    const fixed = 16 / (54 * screenScale)
    const scale = this.avatarActive
      ? Math.min(1, Math.max(0.25, 1 / this.zoom), fixed)
      : this.hd
        ? Math.min(1, fixed)
        : 1
    this.svg.style.setProperty('--marker-scale', String(scale))
    // 人的名字另算：化身模式放大到中间一档时会缩到 6、7 像素，手机上认不出是谁，最小留 12 像素
    const readable = 12 / (54 * screenScale)
    this.svg.style.setProperty('--name-scale', String(scaled ? Math.max(scale, readable) : scale))
    this.residents.setBodyHeight(this.hd ? VILLAGER_HEIGHT : undefined)
    this.residents.setMarkerScale(scale)
    this.prompts.setScale(4 * scale)
    this.markerScale = scale
    this.anchorProps()
    this.placeDestination()
  }
  /** 人物取名册位置，门取出入口编号对应的门口，道具取图形中心。 */
  setAvatarPrompts(prompts: AvatarPrompt[]) {
    this.prompts.update(prompts, (p) =>
      p.kind === 'person'
        ? this.residents.getMemberPos(p.target)
        : p.kind === 'portal'
          ? this.scene.doorAnchor.get(p.target)
          : this.propCenter(p.target)
    )
  }
  readonly svg: SVGSVGElement
  onPropClick: ((id: string) => void) | null = null
  onVillagerClick: ((id: string) => void) | null = null
  onPromptClick: ((id: string) => void) | null = null
  onAvatarWalkTo: ((target: WalkTarget) => void) | null = null
  private readonly destination = el('g', { class: 'avatar-destination' })
  private destinationAt: WalkTarget | null = null
  private markerScale = 1
  /** 道具立牌最近一次实际画的位置，名字和点击区跟着它 */
  private drawnProps: { id: string; x: number; y: number; base: number; size: number }[] = []
  /** 行走坐标的比例由后端随化身状态给出，不在前端复制一份 */
  private walkUnits?: number
  setAvatarState(state: AvatarState | null) {
    this.walkUnits = state?.units
  }
  private readonly scene: ReturnType<typeof buildStaticMap>
  private readonly sourceAtlas: Atlas
  private readonly spatial?: Spatial
  private readonly topology: Topology
  private readonly theme: MapTheme
  /** 这张地图的地面，只算一次；立体场景建好或平面图画好后就不再留着 */
  private ground?: Ground
  private readonly decor: DecorPlan
  private readonly camera: MapCamera
  private propDefinitions = new Map<string, string>()
  private readonly bubbles = new ThoughtBubbles()
  private readonly residents: ResidentLayer
  private readonly prompts = new PromptLayer()
  private entries: ResidentEntry[] = []
  private selectedId: string | null = null
  /** 道具位置与保存 */
  private readonly positions: PropPositions
  /** 图上画着的道具：地图坐标和立起来用的像素图 */
  private placed: PlacedProp[]
  /** 立体场景里哪些房子掀开屋顶 */
  private readonly rooms: RoomCovers
  /** 立体像素场景；WebGL 不可用或还没加载完时为空，地图退回平面像素图 */
  private hd?: HdScene
  private disposed = false
  /** 立体场景建好或退回平面图之前，SVG 上只有底色和放大的地名；建好前 svg 带 map-loading */
  readonly ready: Promise<void>
  private markReady: () => void = () => {}

  constructor(options: TownMapOptions) {
    const { atlas, topology, container } = options
    this.sourceAtlas = atlas
    this.spatial = options.spatial
    this.topology = topology
    this.propDefinitions = new Map(topology.props.map((p) => [p.id, p.definition ?? '']))
    this.theme = options.theme ?? village
    this.ground = options.ground ?? groundOf(atlas, this.theme)
    this.decor = this.ground.decor
    const scene = (this.scene = buildStaticMap(
      atlas,
      (id) => propArtwork(this.propDefinitions.get(id) ?? ''),
      this.theme
    ))
    this.svg = scene.svg
    this.placed = scene.initialProps
    this.rooms = new RoomCovers(scene.spaceAt)
    this.positions = new PropPositions(
      atlas,
      (locale, at) => scene.position(locale, at),
      options.appearanceFor ??
        ((_, definition) => savedAppearance(definition) ?? defaultAppearance),
      options.spatial,
      options.persistence,
      options.notify ?? ((message) => console.error(message)),
      (marks, props) => this.applyProps(marks, props)
    )
    const localeNames = new Map(topology.locales.map((l) => [l.id, l.name]))
    this.residents = new ResidentLayer(
      this.positionOf.bind(this),
      this.bubbles,
      this.metre,
      (id) => localeNames.get(id) ?? id,
      (id) => this.onVillagerClick?.(id)
    )
    this.destination.append(
      el('circle', { class: 'avatar-destination-halo', r: 44 }),
      el('circle', { class: 'avatar-destination-ring', r: 44 }),
      el('circle', { class: 'avatar-destination-dot', r: 14 })
    )
    this.destination.style.display = 'none'
    this.svg.append(this.residents.layer, this.destination, this.bubbles.layer, this.prompts.layer)
    this.nameHoveredProps()
    container.appendChild(this.svg)
    this.svg.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const prop = event.target instanceof Element ? event.target.closest('[data-prop-id]') : null
      const id = prop?.getAttribute('data-prop-id')
      if (id) {
        event.preventDefault()
        this.onPropClick?.(id)
      }
    })
    this.camera = new MapCamera(
      this.svg,
      container,
      scene.initialView,
      (zoom) => {
        // 平移也会走到这里；只有倍率变了才重新分组
        const zoomed = zoom !== this.zoom
        this.zoom = zoom
        this.bubbles.setZoom(zoom)
        this.applyMarkerScale()
        if (zoomed) this.residents.relayout()
        this.refreshRooms()
      },
      (id) => this.onVillagerClick?.(id),
      (id) => this.onPropClick?.(id),
      (id) => this.onPromptClick?.(id),
      (point) => this.onAvatarWalkTo?.(this.walkTarget(point)),
      (key, client) => this.residents.openGroup(key, client),
      // 双指上下拖调俯角：和右键拖动同样每像素 0.2 度
      (dy) => {
        if (this.hd) this.hd.setPitch(this.hd.pitch + dy * 0.2)
      }
    )
    this.svg.classList.add('map-loading')
    this.ready = new Promise((resolve) => (this.markReady = resolve))
    this.startHd(atlas)
  }

  private loaded() {
    this.svg.classList.remove('map-loading')
    this.markReady()
  }

  /** 立体场景按需加载；加载或建场景失败（比如没有 WebGL）就退回平面像素地面 */
  private startHd(atlas: Atlas) {
    void import('./map/hd2d/scene')
      .then(({ HdScene }) => {
        const container = this.svg.parentElement
        if (this.disposed || !container || !this.ground) return
        this.hd = new HdScene(atlas, this.ground, container, this.svg)
        this.ground = undefined
        this.svg.classList.add('hd2d')
        this.applyMarkerScale()
        if (this.clock) this.hd.setClock(...this.clock)
        this.rooms.attach(this.svg, this.hd.houses)
        this.hd.onTilt = () => this.applyTilt()
        this.hd.onVillagersMoved = () => this.followVillagers()
        this.applyTilt()
        if (this.viewInsets) this.hd.setFocusInsets(this.viewInsets.top, this.viewInsets.bottom)
      })
      .catch((error) => {
        console.warn('立体像素场景未能启动，使用平面地图', error)
        this.showFlat(atlas)
      })
      .finally(() => this.loaded())
  }
  /** 平面像素地面（带树）垫在 SVG 最底层，天气和昼夜也改由 SVG 天气层画 */
  private showFlat(atlas: Atlas) {
    if (this.disposed || !this.ground) return
    this.scene.showTerrain(paintGround(this.ground, true))
    this.ground = undefined
    this.weather = new WeatherLayer(this.svg, atlas)
    this.svg.insertBefore(this.weather.layer, this.residents.layer)
    if (this.lastRoster) this.weather.handleMsg(this.lastRoster)
  }
  /** 地面随俯角倾斜：地图视口纵向压扁，立着的文字按比例拉回，房间名跟着屋顶高度走 */
  private applyTilt() {
    if (!this.hd) return
    this.camera.setVerticalScale(this.hd.verticalScale)
    this.residents.update(this.entries)
    this.placeDestination()
    this.rooms.reset()
    this.refreshRooms()
    this.standLabels()
  }
  /** 地名、房间名和道具名按俯角拉回；跟着立牌走的道具名和房间名挪动时各自再拉一次 */
  private standLabels() {
    const k = this.hd ? 1 / this.hd.verticalScale : 1
    for (const label of this.svg.querySelectorAll('.rg, .rm, .pl')) standUpright(label, k)
  }
  private clock?: [number, string | undefined]

  /** 立体场景跟上房子的开合（见 RoomCovers）、村民和道具立牌；fresh 表示刚来了一份名册 */
  private refreshRooms(fresh = false) {
    const hd = this.hd
    if (!hd) return
    const avatar = this.entries.find((e) => e.member.kind === 'avatar')
    const [x, y, w, h] = this.zoom >= 1.5 ? (this.camera?.getViewBox() ?? []) : []
    const changed = this.rooms.update([
      this.selectedId ? this.residents.getMemberAnchor(this.selectedId) : undefined,
      avatar && this.residents.getMemberAnchor(avatar.member.id),
      w ? [x + w / 2, y + h / 2] : undefined,
    ])
    const covered = this.rooms.covered
    this.residents.setCovered(covered)
    hd.setVillagers(this.villagerPlacements(covered), fresh)
    if (!changed) return
    this.rooms.apply(hd)
    this.drawnProps = hd.setProps(this.coverProps(covered))
    this.anchorProps()
  }

  /** 立体场景里道具名字不常驻：指到（或键盘聚焦）某个道具时才出现，选中的道具一直有 */
  private nameHoveredProps() {
    const toggle = (target: EventTarget | null, on: boolean) => {
      const id = (target as Element | null)
        ?.closest?.('[data-prop-id]')
        ?.getAttribute('data-prop-id')
      if (!id) return
      const selected = this.scene.props.get(id)?.classList.contains('selected-prop')
      this.scene.propLabels.get(id)?.classList.toggle('named', on || !!selected)
    }
    for (const type of ['pointerover', 'focusin'])
      this.svg.addEventListener(type, (e) => toggle(e.target, true))
    for (const type of ['pointerout', 'focusout'])
      this.svg.addEventListener(type, (e) => toggle(e.target, false))
  }

  /** 道具的点击区和名字跟着立牌走：点击区在立牌中心，名字挂在立牌头顶再高一点 */
  private anchorProps() {
    const up = this.hd ? 1 / this.hd.verticalScale : 1
    for (const p of this.drawnProps) {
      // 点击区中心对准立牌中心：立牌底边在 base，向上立起 size（屏幕上按俯角拉回）
      const centre = p.base - (p.size * up) / 2
      this.scene.props.get(p.id)?.setAttribute('transform', `translate(${p.x} ${centre})`)
      const label = this.scene.propLabels.get(p.id)
      if (!label) continue
      label.setAttribute('x', String(p.x))
      label.setAttribute('y', String(p.base - p.size * up - 18 * this.markerScale * up))
      standUpright(label, up)
    }
  }

  private villagerPlacements(covered: (p: [number, number]) => boolean): VillagerPlacement[] {
    return this.entries.flatMap(({ member }) => {
      const p = this.residents.getMemberPos(member.id)
      return p
        ? [
            {
              id: member.id,
              look: this.residents.lookOf(member.id),
              x: p[0],
              y: p[1],
              visible: !covered(p),
              condition:
                member.body?.life === 'dead'
                  ? ('dead' as const)
                  : member.body && !member.body.can_decide
                    ? ('incapacitated' as const)
                    : ('normal' as const),
            },
          ]
        : []
    })
  }

  /** 盖着屋顶的房子里的道具连名字藏起来；有像素图的道具在立体场景里立起来，SVG 里的图只留作点击区 */
  private coverProps(covered: (p: [number, number]) => boolean): PropPlacement[] {
    const standees: PropPlacement[] = []
    for (const { id, at, art } of this.placed) {
      const hidden = covered(at)
      this.scene.props.get(id)?.classList.toggle('roofed', hidden)
      this.scene.propLabels.get(id)?.classList.toggle('roofed', hidden)
      if (art)
        standees.push({ id, url: art.url, x: at[0], y: at[1], size: art.size, visible: !hidden })
    }
    return standees
  }

  /** SVG 单位每米；没有三维数据时人物位置直接来自平面图集，不需要换算 */
  private get metre(): number | undefined {
    return this.spatial?.svg_units_per_metre
  }

  private positionOf(locale: string, at: ResidentEntry['member']['at']) {
    if (!this.spatial) return this.scene.position(locale, at)
    const p = spatialPosition(this.spatial, locale, at)
    const metre = this.spatial.svg_units_per_metre
    return p ? ([p[0] * metre, p[2] * metre] as [number, number]) : undefined
  }

  private get walkUnit(): number {
    return this.walkUnits ?? this.metre ?? LEGACY_UNITS_PER_METRE
  }
  /** 画面坐标 → 米制行走坐标。有三维数据时全图一个比例，否则按房间的摊开变换反算。 */
  private walkTarget(point: [number, number]): WalkTarget {
    const space = this.scene.spaceAt(point)
    const [x, y] = this.spatial ? point : this.scene.toLocal(space, point)
    return { space, position: [x / this.walkUnit, y / this.walkUnit] }
  }
  /** walkTarget 的反向：米制行走坐标 → 画面坐标 */
  private walkPoint(target: WalkTarget): [number, number] {
    const [x, y] = [target.position[0] * this.walkUnit, target.position[1] * this.walkUnit]
    return this.spatial ? [x, y] : this.scene.toWorld(target.space, x, y)
  }
  /** 选路用的格子图：第一次要走路时才建，之后跟着地图上的道具更新障碍 */
  private routes?: WalkRoutes
  private routeMarks: { id: string; at: [number, number] }[] = []
  walkRoute(from: WalkTarget, to: WalkTarget): WalkStep[] | null {
    if (!this.routes) {
      this.routes = new WalkRoutes(this.sourceAtlas, this.topology, this.walkUnit, !!this.spatial)
      this.applyRouteObstacles()
    }
    return this.routes.find(from, to)
  }
  /** 挡路的就是画在图上的道具；拿走或收进容器的本来就不画。
   *  有三维数据时道具按自己的占地算，树木也一并算上，与 maps/walk.rs 一致。 */
  private applyRouteObstacles() {
    const footprints = new Map(this.spatial?.props.map((p) => [p.id, p.footprint]))
    const obstacles = this.routeMarks.map((mark) => {
      const size = footprints.get(mark.id)
      return {
        ...this.walkTarget(mark.at),
        half: size ? ([size[0] / 2, size[1] / 2] as [number, number]) : PROP_HALF,
      }
    })
    for (const v of this.spatial?.vegetation ?? [])
      if (v.collider_radius > 0)
        obstacles.push({
          space: OUTDOOR_SPACE,
          position: [v.position[0], v.position[2]],
          half: [v.collider_radius, v.collider_radius],
        })
    // 二维地图的装饰树（town-shared/decor）同样挡路，与 spatial.vegetation 一致
    if (!this.spatial) {
      const unit = this.walkUnit
      for (const v of this.decor.vegetation) {
        if (!v.kind.startsWith('tree')) continue
        obstacles.push({
          space: OUTDOOR_SPACE,
          position: [v.x / unit, v.y / unit],
          half: [0.5, 0.5],
        })
      }
    }
    this.routes?.setObstacles(obstacles)
  }
  walkTargetOf(kind: 'person' | 'prop', id: string) {
    // 道具按摆放的位置（和后端判断够不够得着、选路避让用的是同一个点），不按画出来的图形中心：
    // 公告栏、摊位这类高的道具图形中心在摆放点北边好几米，走到那里还是够不着
    const point =
      kind === 'person'
        ? this.residents.getMemberAnchor(id)
        : (this.placed.find((p) => p.id === id)?.at ?? this.propCenter(id))
    return point ? this.walkTarget(point) : undefined
  }
  setAvatarDestination(target: WalkTarget | null) {
    this.destinationAt = target
    this.placeDestination()
  }
  /** 目的地标记跟着人物标记一起反向缩放，放大后不会盖住半张图 */
  private placeDestination() {
    this.destination.style.display = this.destinationAt ? '' : 'none'
    if (!this.destinationAt) return
    const [x, y] = this.walkPoint(this.destinationAt)
    const s = this.markerScale,
      sy = s * uprightRatio(this.svg)
    this.destination.setAttribute(
      'transform',
      `translate(${x} ${y})${s === 1 && sy === 1 ? '' : ` scale(${s} ${sy})`}`
    )
  }

  handleMsg(msg: ServerMsg) {
    this.weather?.handleMsg(msg)
    if (msg.type === 'roster') {
      this.lastRoster = msg
      this.clock = [msg.sim_minutes, msg.environment?.kind]
      this.hd?.setClock(...this.clock)
    }
    if (msg.type === 'population') {
      this.residents.setPopulation(msg.population.residents)
      this.refreshRooms()
    }
  }
  disconnect() {
    this.weather?.disconnect()
  }
  dispose() {
    this.disposed = true
    this.markReady()
    this.hd?.dispose()
    this.weather?.dispose()
    this.positions.dispose()
    this.camera.dispose()
    this.residents.dispose()
    this.svg.remove()
  }

  /** 道具位置算好（PropPositions）：重画道具，交给立体场景、寻路和感知 */
  private applyProps(marks: Atlas['props'], props: PropView[]) {
    this.propDefinitions = new Map(props.map((p) => [p.id, p.definition ?? '']))
    // 地图上的书：挨着的几本合成一摞画
    const books = new Map(
      props.filter((p) => p.readable?.kind === 'book').map((p) => [p.id, p.locale])
    )
    this.placed = this.scene.replaceProps(marks, books)
    this.rooms.reset()
    this.refreshRooms()
    this.standLabels()
    this.routeMarks = this.placed.map(({ id, at }) => ({ id, at }))
    this.applyRouteObstacles()
  }

  setProps(props: PropView[]) {
    this.positions.update(props)
  }
  /** 这件道具画在一摞书里：点它打开「书与公告」里这个地点的书，不弹单本的卡片 */
  isBookPile(id: string) {
    return !!this.scene.props.get(id)?.classList.contains('book-pile')
  }
  /** 道具图形的中心；没有图形时返回 undefined */
  private propCenter(id: string): [number, number] | undefined {
    const shape = this.scene.props.get(id)
    const graphic = shape instanceof SVGGraphicsElement ? shape : undefined
    const box = graphic?.getBBox()
    const matrix = graphic?.transform.baseVal.consolidate()?.matrix
    return box && matrix
      ? [matrix.e + box.x + box.width / 2, matrix.f + box.y + box.height / 2]
      : undefined
  }
  locateProp(id: string, locale: string) {
    const shape = this.scene.props.get(id)
    const pos = this.propCenter(id) ?? this.scene.localeAnchor.get(locale)
    if (pos) {
      const view = this.camera.getViewBox()
      const width = Math.min(view[2], 1500),
        height = (width * view[3]) / view[2]
      this.camera.setViewBox([pos[0] - width / 2, pos[1] - height / 2, width, height])
    }
    this.svg
      .querySelectorAll('.selected-prop')
      .forEach((el) => el.classList.remove('selected-prop'))
    this.svg.querySelectorAll('.pl.named').forEach((el) => el.classList.remove('named'))
    shape?.classList.add('selected-prop')
    this.scene.propLabels.get(id)?.classList.add('named')
  }
  onReset() {
    this.lastRoster = undefined
    this.weather?.reset()
    this.bubbles.onReset()
    this.entries = []
  }
  setSpeed(speed: number) {
    this.bubbles.setSpeed(speed)
    this.weather?.setSpeed(speed)
  }
  /** 村民在屏幕上的位置：按画出来的立牌算（比名册晚一点），聊天气泡等跟着人走的东西不超前 */
  getScreenPos(id: string): [number, number] | undefined {
    const p = this.getMemberPos(id),
      matrix = this.svg.getScreenCTM()
    if (!p || !matrix) return
    const [dx, dy] = this.hd?.villagerLag(id) ?? [0, 0]
    const point = new DOMPoint(p[0] + dx, p[1] + dy).matrixTransform(matrix)
    return [point.x, point.y]
  }
  /** 村民在屏幕上的范围：立牌高度按横向缩放折算；平面地图退回头像标记的尺寸 */
  getScreenBox(id: string): ScreenBox | undefined {
    const p = this.getScreenPos(id),
      a = Math.abs(this.svg.getScreenCTM()?.a || 1)
    if (!p) return
    const height = this.hd ? VILLAGER_HEIGHT : 108 * this.markerScale
    const half = this.hd ? VILLAGER_HALF : 58 * this.markerScale
    return { x: p[0], feet: p[1], top: p[1] - height * a, half: half * a }
  }
  getMemberPos(id: string) {
    return this.residents.getMemberPos(id)
  }
  /** 地图被面板盖住的四边；立体场景晚一步建好时补上 */
  private viewInsets: { top: number; right: number; bottom: number; left: number } | undefined
  setViewInsets(insets: { top: number; right: number; bottom: number; left: number }) {
    this.camera.setInsets(insets)
    this.viewInsets = insets
    this.hd?.setFocusInsets(insets.top, insets.bottom)
  }
  panTo(x: number, y: number) {
    this.camera.panTo(x, y)
  }
  getViewBox() {
    return this.camera.getViewBox()
  }
  setViewBox(view: number[]) {
    this.camera.setViewBox(view)
  }
  /** 立体场景的俯角；平面地图没有 */
  /** 地图画质（设定 · 显示） */
  setRenderQuality(quality: Quality) {
    this.hd?.setQuality(quality)
  }
  mapPitch() {
    return this.hd?.pitch
  }
  setMapPitch(degrees: number) {
    this.hd?.setPitch(degrees)
  }
  /** 进游戏后第一份名册里选中的人：镜头对准他，不停在空广场 */
  private rosters = 0
  setSelected(id: string | null) {
    this.selectedId = id
    this.residents.setSelected(id)
    const pos = id && this.rosters === 1 ? this.residents.getMemberPos(id) : undefined
    if (pos) {
      this.camera.lookAt(pos[0], pos[1])
      this.rosters++
    }
    this.refreshRooms()
  }
  update(entries: ResidentEntry[]) {
    if (this.rosters < 2) this.rosters++
    this.entries = entries
    this.residents.update(entries)
    this.refreshRooms(true)
  }

  /** 立牌比名册晚一点、匀速走：名字和心声泡按名册摆好后，平移回立牌头上，跟着它一起走 */
  private followVillagers() {
    const hd = this.hd
    if (!hd) return
    for (const { member } of this.entries) {
      const lag = hd.villagerLag(member.id)
      this.residents.follow(member.id, lag)
      this.bubbles.follow(member.id, lag)
    }
  }
}
