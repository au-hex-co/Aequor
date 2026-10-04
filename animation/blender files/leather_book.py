"""
Tooled leather-bound book that opens and closes like a real case-bound (hardcover) book.
Paste into Blender > Scripting tab > Run Script (the "play" button).
Written for Blender 4.x / 5.x (tested on 5.2). Units: metres. Render engine: Cycles.

HOW THE BOOK WORKS (plain language)
 * The two covers and the SPINE are hard, stiff pieces. They never bend.
 * The spine is joined to each cover by a narrow bendy strip of leather (the "joint").
   Only the two joints bend. So opening the book is a chain:
        back cover - joint - SPINE - joint - front cover
   Closed: the spine stands upright at the back of the book.
   Open: both joints straighten and the spine lies flat between the two covers.
 * Every PAGE is its own thin sheet (an independent object). When the book opens each sheet
   curves up and over in its own arc. A sheet keeps its real length, so a curved sheet reaches
   less far across the table than a flat one: the pages get shorter as they curve.
   The sheets near the middle of the stack bow the most, so the edge of the pages fans out.
 * A strip of cloth (the hinge) joins the two page stacks in the centre fold.
 * Everything is controlled by ONE number: the "open" property on the empty called BookOpen
   (0 = closed, 1 = fully open). It is keyframed for you, and everything else follows it.
"""
import bpy
import bmesh
import math
import bisect
from mathutils import Vector, Matrix

# =============================================================================
# 1. SETTINGS - change these numbers to tweak the result
# =============================================================================
# --- Size (metres: 0.15 = 15 cm) ---
BOOK_W        = 0.15     # width of the pages (spine -> fore-edge)
BOOK_H        = 0.22     # height of the pages (bottom -> top of the book)
PAGE_HALF     = 0.0175   # thickness of EACH page stack (two stacks = 3.5 cm)
COVER_T       = 0.003    # thickness of the leather boards and spine
OVERHANG      = 0.006    # how far the covers stick out past the pages
COVER_BEVEL   = 0.0012   # rounding on covers/spine (must be less than COVER_T / 2)

# --- Spine (hard) and joints (bendy) ---
JOINT_RADIUS  = 0.005    # size of the bendy joint strips (must be more than half of COVER_T)
BAND_COUNT    = 5        # raised bands across the spine
BAND_W        = 0.009    # width of each band
BAND_HEIGHT   = 0.0022   # how far each band sticks out

# --- Pages: every page is its own sheet ---
PAGES_PER_SIDE   = 28      # sheets in each half of the book (more = finer, but heavier)
PAGE_THICKNESS   = 0.0004  # thickness of one sheet of paper (must be less than PAGE_HALF / PAGES_PER_SIDE)
PAGE_ARCH_HEIGHT = 0.009   # how high the top sheets bow up when the book is open (metres)
PAGE_ARCH_POS    = 0.030   # distance from the centre fold where the bow is highest (metres)
PAGE_RISE_WIDTH  = 0.030   # how far from the fold a sheet takes to climb up to its place in the stack
PAGE_RIPPLE      = 0.0025  # waviness of the sheets: strongest at the fore-edge of the top sheets, none at the binding (metres; 0 = flat)
TEXT_ON          = True    # lines of printed text on the pages
BACK_FAN         = 0.1     # how far the lower sheets are spread outward at the fold (0 = none, 1 = lots)
STACK_OFFSET     = 0.010   # gap (each side) between the centre fold and where the pages start; the cloth bridges it

# --- Cloth hinge in the centre fold ---
FABRIC_ON     = True     # cloth strip joining the two page stacks
FABRIC_W      = 0.03     # how far the cloth reaches onto each page (metres)
FABRIC_COLOR  = (0.50, 0.42, 0.29, 1)   # cloth colour

# --- Title plate on the front cover ---
TITLE_PLATE   = True
PLATE_SIZE    = (0.05, 0.009)    # width, height
PLATE_Y       = 0.186            # distance of plate centre from the bottom of the book

# --- Stitched border (small slanted stitches along the front cover edge) ---
STITCHES      = True
STITCH_INSET  = 0.009    # distance of stitches from the cover edge
STITCH_STEP   = 0.0085   # distance between stitches
STITCH_LEN    = 0.0055   # length of one stitch
STITCH_WIDTH  = 0.0013   # thickness of thread
STITCH_ANGLE  = 25       # slant of the stitches, in degrees

# --- Animation ---
FRAME_START   = 1
FRAME_END     = 60

# --- Colours (Red, Green, Blue, Alpha) - values 0 to 1 ---
LEATHER_DARK  = (0.075, 0.013, 0.005, 1)   # darkest leather
LEATHER_LIGHT = (0.22, 0.042, 0.016, 1)    # lightest leather
LEATHER_WORN  = (0.45, 0.20, 0.09, 1)      # colour of worn, rubbed edges
PAPER_DARK    = (0.80, 0.72, 0.55, 1)      # each sheet gets a slightly different shade
PAPER_LIGHT   = (0.95, 0.90, 0.77, 1)
THREAD_COLOR  = (0.85, 0.75, 0.55, 1)
PLATE_COLOR   = (0.90, 0.65, 0.25, 1)

# --- Leather look ---
GRAIN_SCALE     = 450    # bigger = smaller pebbles
GRAIN_STRENGTH  = 0.45   # how bumpy the pebbled grain is
WEAR_AMOUNT     = 0.85   # 0 = no worn edges, 1 = very worn
WEAR_DISTANCE   = 0.0015 # how far from an edge the wear reaches (metres) - keep BELOW the cover thickness
COAT_WEIGHT     = 0.15   # waxy clear layer on top (0 = none)
COAT_ROUGHNESS  = 0.4

# --- Emboss (tree-of-life) ---
# Put the path of YOUR OWN grayscale height map here (white = raised, black = sunken),
# e.g.  r"C:\Users\you\Pictures\tree_of_life_height.png"
# Leave as "" to use the generated placeholder picture.
HEIGHTMAP_PATH  = ""
EMBOSS_STRENGTH = 1.0
EMBOSS_DEPTH    = 0.0018   # real-world relief in metres (1.8 mm)

# --- Render / scene ---
RENDER_SAMPLES  = 128
PREVIEW_SAMPLES = 32
RES_X, RES_Y    = 1920, 1080
CAM_LOCATION    = (0.38, -0.36, 0.30)    # camera position
CAM_TARGET      = (-0.01, 0.10, 0.01)    # point the camera looks at
CAM_LENS        = 50                     # focal length in mm
KEY_COLOR       = (1.0, 0.72, 0.45, 1)   # warm main light
FILL_COLOR      = (0.55, 0.70, 1.0, 1)   # cool fill light
KEY_POWER       = 22                     # watts
FILL_POWER      = 6
RIM_POWER       = 10
BACKGROUND      = (0.012, 0.012, 0.016, 1)


# =============================================================================
# 2. DERIVED NUMBERS + HELPER FUNCTIONS (you don't need to touch these)
# =============================================================================
scene = bpy.context.scene
COLL_NAME = "LeatherBook"
CT = COVER_T
H2 = PAGE_HALF
RJ = JOINT_RADIUS
N = PAGES_PER_SIDE
TOTAL_T = 2 * CT + 2 * H2              # thickness of the closed book
MID = CT + H2                          # height of the seam between the two page stacks
COV_W = BOOK_W + OVERHANG              # cover width
COV_H = BOOK_H + 2 * OVERHANG
XB = RJ - CT / 2                       # gap between the page stack and the spine's inner face
SPINE_L = TOTAL_T - CT - 2 * RJ        # length of the hard spine piece
JOINT_L = math.pi / 2 * RJ             # length of one bendy joint strip
OPEN_GAP = TOTAL_T - CT + 2 * RJ       # distance between the two covers when the book is open
QX = -OPEN_GAP / 2                     # the middle of the open book (centre fold)
SPINE_ROT = (math.pi / 2, 0, 0)        # bendy strips are built in a turned frame (see below)


def cleanup():
    """Remove a previous run of this script + the default cube/camera/light."""
    old = bpy.data.collections.get(COLL_NAME)
    if old:
        for o in list(old.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(old)
    for nm in ("Cube", "Light", "Camera"):
        o = bpy.data.objects.get(nm)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)
    for nm in ("Leather_Front", "Leather", "Leather_Spine", "Leather_Joint", "Paper", "Thread",
               "Brass", "Floor", "Fabric"):
        m = bpy.data.materials.get(nm)
        if m:
            bpy.data.materials.remove(m)
    for c in [c for c in bpy.data.curves if c.name.startswith("Joint_")]:
        bpy.data.curves.remove(c)
    for me in [m for m in bpy.data.meshes if m.users == 0]:
        bpy.data.meshes.remove(me)
    im = bpy.data.images.get("TreeOfLife_HeightMap_PLACEHOLDER")
    if im:
        bpy.data.images.remove(im)


def make_box(name, mn, mx, coll, origin=None):
    """Make a box between two corners (world coords). origin = where the object's pivot sits."""
    mn, mx = Vector(mn), Vector(mx)
    center = (mn + mx) / 2
    origin = center if origin is None else Vector(origin)
    size = mx - mn
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size.x, v.co.y * size.y, v.co.z * size.z)) + center - origin
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.location = origin
    coll.objects.link(obj)
    return obj


def smooth_and_bevel(obj, width, segments=3):
    """Shade Smooth + Bevel modifier (rounds the sharp edges)."""
    if hasattr(obj.data, "shade_smooth"):
        obj.data.shade_smooth()
    else:
        for p in obj.data.polygons:
            p.use_smooth = True
    mod = obj.modifiers.new("Bevel", 'BEVEL')
    mod.width = width
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    try:
        mod.harden_normals = True   # keeps the big flat faces looking flat
    except Exception:
        pass


def node(nt, idname, x, y, label=None, **props):
    n = nt.nodes.new(idname)
    n.location = (x, y)
    if label:
        n.label = label
    for k, v in props.items():
        setattr(n, k, v)
    return n


def link(nt, a, b):
    nt.links.new(a, b)


def set_in(n, names, value):
    """Set an input by name, trying several names (names change between Blender versions)."""
    if isinstance(names, str):
        names = (names,)
    for nm in names:
        s = n.inputs.get(nm)
        if s is not None:
            s.default_value = value
            return True
    return False


def ramp(nt, x, y, stops, label=None):
    """Colour ramp from a list of (position, (r,g,b,a))."""
    n = node(nt, 'ShaderNodeValToRGB', x, y, label)
    cr = n.color_ramp
    cr.elements[0].position = stops[0][0]
    cr.elements[1].position = stops[-1][0]
    for pos, col in stops[1:-1]:
        cr.elements.new(pos).color = col
    cr.elements[0].color = stops[0][1]
    cr.elements[-1].color = stops[-1][1]
    return n


def mix_color(nt, x, y, blend, fac):
    """Colour mix node. Inputs: [0]=Factor, [6]=A, [7]=B. Output: [2]."""
    n = node(nt, 'ShaderNodeMix', x, y, data_type='RGBA', blend_type=blend)
    n.inputs[0].default_value = fac
    return n


def new_material(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True          # needed in older Blender; harmless in new ones
    except Exception:
        pass
    m.node_tree.nodes.clear()
    return m


def add_driver(owner, prop, index, expr, ctl):
    """Make `owner.prop` follow the BookOpen 'open' value (called o) through a small formula."""
    fc = owner.driver_add(prop, index) if index >= 0 else owner.driver_add(prop)
    d = fc.driver
    d.type = 'SCRIPTED'
    d.expression = expr
    v = d.variables.new()
    v.name = "o"
    v.type = 'SINGLE_PROP'
    v.targets[0].id = ctl
    v.targets[0].data_path = '["open"]'


def follow_empty(owner, prop, index, empty, axis):
    """Make owner.prop copy the world position (axis = 'LOC_X' or 'LOC_Z') of an empty."""
    fc = owner.driver_add(prop, index)
    d = fc.driver
    d.type = 'SUM'
    v = d.variables.new()
    v.name = "p"
    v.type = 'TRANSFORMS'
    v.targets[0].id = empty
    v.targets[0].transform_type = axis
    v.targets[0].transform_space = 'WORLD_SPACE'


# =============================================================================
# 3. THE SHAPE OF THE OPEN PAGES (each sheet keeps its length while it curves)
# =============================================================================
def back_end_x(zr):
    """x position where a sheet at height zr (right-hand stack) is attached next to the spine:
    a flat wall with the bottom corner rounded to fit inside the bendy joint."""
    d = max(0.0, CT + XB - zr)
    return -math.sqrt(max(XB * XB - d * d, 0.0))


def smoothstep(a):
    a = min(1.0, max(0.0, a))
    return a * a * (3 - 2 * a)


def sheet_height(x, t):
    """Height above the floor of an OPEN sheet at distance x from the centre fold.
    t = 0 for the sheet resting on the cover ... 1 for the sheet in the middle of the book."""
    xa = STACK_OFFSET + BACK_FAN * H2 * (1 - t)            # where this sheet is attached (lower = further out)
    r = smoothstep((x - xa) / PAGE_RISE_WIDTH)             # climbs from the floor to its place in the stack
    c = PAGE_ARCH_POS
    hump = (x / c) * math.exp(1 - x / c)                   # rises quickly, peaks at x = c, then eases away
    return CT + r * (t * H2 + PAGE_ARCH_HEIGHT * t ** 1.5 * hump)


def sheet_path(t, length):
    """Walk along an open sheet in tiny steps, adding up its real length as we go.
    Returns lists of (distance from fold, length so far)."""
    step = 0.0004
    xa = STACK_OFFSET + BACK_FAN * H2 * (1 - t)
    xs, cum, zprev = [xa], [0.0], CT
    for i in range(1, int(length / step) + 6):
        x = xa + i * step
        z = sheet_height(x, t)
        cum.append(cum[-1] + math.hypot(step, z - zprev))
        xs.append(x)
        zprev = z
        if cum[-1] >= length:
            break
    return xs, cum


def sheet_point(path, s, zfun):
    """Where is the point that is a length s along the sheet? (this is what makes pages 'get shorter')"""
    xs, cum = path
    i = bisect.bisect_left(cum, s)
    if i <= 0:
        x = xs[0]
    elif i >= len(cum):
        x = xs[-1]
    else:
        f = (s - cum[i - 1]) / (cum[i] - cum[i - 1])
        x = xs[i - 1] + f * (xs[i] - xs[i - 1])
    return x, zfun(x)


RIPPLE_START = STACK_OFFSET + FABRIC_W      # no waves under the cloth hinge
RIPPLE_RAMP = BOOK_W - RIPPLE_START         # waves grow gradually all the way out to the fore-edge


def page_ripple(xc, y, t, idx):
    """Height (metres) of the gentle waviness of a sheet at distance xc from the fold and height y.
    Real pages wave mostly near the free fore-edge and hardly at all near the binding. The waves are
    a few unrelated wavelengths mixed together, and their crests drift slowly with xc so they are
    slightly slanted and never run in perfect parallel lines. Every sheet shares the same waves (scaled
    by t, so they stay stacked and never cross), plus a tiny per-sheet difference."""
    env = smoothstep((xc - RIPPLE_START) / RIPPLE_RAMP)
    env = env * env * (3 - 2 * env)                          # extra-soft start next to the binding
    w = (0.55 * math.sin(2 * math.pi * y / 0.113 + 1.3 + 9.0 * xc)
         + 0.30 * math.sin(2 * math.pi * y / 0.067 + 4.1 - 14.0 * xc)
         + 0.15 * math.sin(2 * math.pi * y / 0.039 + 2.2 + 6.0 * xc))
    return PAGE_RIPPLE * t * env * w + 0.00002 * env * math.sin(7.31 * idx + 3.0 * xc + 11.0 * y)


def make_sheet(name, mirror, idx, coll, nseg=64, nsegy=48):
    """One independent sheet of paper (idx = 0 is the sheet next to the cover). Has a closed
    (flat) shape and an 'Open' shape key with the curved shape. The sheet has nsegy rows across its
    height so that it can really wave."""
    frac = (idx + 0.5) / N
    d = frac * H2
    z_c = (MID + d) if mirror else (CT + d)                # closed height of this sheet
    zr = (MID - d) if mirror else z_c                      # same sheet seen from the right-hand side
    t = (1 - frac) if mirror else frac                     # 0 = against the cover, 1 = in the middle
    x0 = back_end_x(zr)
    length = BOOK_W - x0
    path = sheet_path(t, length)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rows = []
    for k in range(nseg + 1):
        x = x0 + length * k / nseg
        rows.append([bm.verts.new((x, -BOOK_H / 2 + BOOK_H * j / nsegy, 0.0)) for j in range(nsegy + 1)])
    for a, b in zip(rows[:-1], rows[1:]):
        for j in range(nsegy):
            bm.faces.new((a[j], b[j], b[j + 1], a[j + 1]))
    bm.to_mesh(me)
    bm.free()
    # UV map = position on the page (used for the printed text). Left-hand pages are flipped
    # over when the book opens, so their text direction is reversed to read the right way round.
    uvl = me.uv_layers.new(name="PageUV")
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            u = (vi // (nsegy + 1)) / nseg
            uvl.data[li].uv = ((1 - u) if mirror else u, (vi % (nsegy + 1)) / nsegy)
    obj = bpy.data.objects.new(name, me)
    obj.location = (0, BOOK_H / 2, z_c)
    coll.objects.link(obj)
    obj.shape_key_add(name="Basis", from_mix=False)
    sk = obj.shape_key_add(name="Open", from_mix=False)
    for k, (dkey, v) in enumerate(zip(sk.data, me.vertices)):
        s = length * (k // (nsegy + 1)) / nseg
        xc, zo = sheet_point(path, s, lambda x: sheet_height(x, t))
        zo += page_ripple(xc, v.co.y, t, idx)              # gentle waviness, mostly towards the fore-edge
        z_new = (2 * MID - zo) if mirror else zo           # left-hand sheets are flipped over with the cover
        dkey.co = Vector((QX + xc, v.co.y, z_new - z_c))
    sk.value = 0.0
    return obj, sk


def fabric_z(x):
    """The cloth lies flat on the spine across the gap, then follows the top sheet."""
    return CT + 0.0002 if x < STACK_OFFSET else sheet_height(x, 1.0) + 0.0002


def fabric_path(length):
    step = 0.0004
    xs, cum, zprev = [0.0], [0.0], fabric_z(0.0)
    for i in range(1, int(length / step) + 6):
        x = i * step
        z = fabric_z(x)
        cum.append(cum[-1] + math.hypot(step, z - zprev))
        xs.append(x)
        zprev = z
        if cum[-1] >= length:
            break
    return xs, cum


def make_fabric(name, mirror, coll):
    """Thin cloth strip lying on the middle sheet, next to the centre fold, with its 'Open' shape."""
    n = 40
    x0 = -XB
    path = fabric_path(FABRIC_W + XB + 0.01)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rows = []
    for i in range(n + 1):
        x = x0 + (FABRIC_W + XB) * i / n
        rows.append((bm.verts.new((x, -BOOK_H / 2, 0.0)), bm.verts.new((x, BOOK_H / 2, 0.0))))
    for a, b in zip(rows[:-1], rows[1:]):
        bm.faces.new((a[0], b[0], b[1], a[1]))
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    obj.location = (0, BOOK_H / 2, MID)
    coll.objects.link(obj)
    obj.shape_key_add(name="Basis", from_mix=False)
    sk = obj.shape_key_add(name="Open", from_mix=False)
    for k, (dkey, v) in enumerate(zip(sk.data, me.vertices)):
        s = (FABRIC_W + XB) * (k // 2) / n
        xc, zo = sheet_point(path, s, fabric_z)
        z_new = (2 * MID - zo) if mirror else zo
        dkey.co = Vector((QX + xc, v.co.y, z_new - MID))
    sk.value = 0.0
    return obj, sk


# =============================================================================
# 4. MATERIALS (all built from nodes)
# =============================================================================
def make_emboss_image():
    """Generated placeholder 'height map': grey = flat, white = raised, dark = sunken."""
    if HEIGHTMAP_PATH:
        img = bpy.data.images.load(HEIGHTMAP_PATH)
        img.colorspace_settings.name = 'Non-Color'
        return img
    W, H = 512, int(512 * COV_H / COV_W)
    img = bpy.data.images.new("TreeOfLife_HeightMap_PLACEHOLDER", W, H, alpha=False)
    img.colorspace_settings.name = 'Non-Color'   # set this FIRST (changing it later wipes the pixels)
    cw, ch = COV_W, COV_H                    # cover size in metres
    cx, hw, y0, y1, rad = cw / 2, 0.042, 0.075, 0.135, 0.042
    buf = [0.5] * (W * H * 4)
    for j in range(H):
        y = (j + 0.5) / H * ch
        for i in range(W):
            x = (i + 0.5) / W * cw
            v = 0.5
            d = min(x, cw - x, y, ch - y)                     # distance from cover edge
            if 0.014 < d < 0.020 or 0.027 < d < 0.0295:       # double border line
                v = 0.85
            # arched panel (tree-of-life window)
            if y > y1:
                s = rad - math.hypot(x - cx, y - y1)
            else:
                s = min(x - (cx - hw), (cx + hw) - x, y - y0)
            if s > 0.0035:
                v = 0.32                                      # sunken panel floor
                # trunk
                if abs(x - cx) < 0.0045 and 0.08 < y < 0.125:
                    v = 0.9
                # canopy rings
                r = math.hypot(x - cx, y - 0.145)
                if 0.026 < r < 0.030 or 0.015 < r < 0.018:
                    v = 0.9
                # roots
                if y < 0.09 and abs(abs(x - cx) - (0.09 - y) * 0.7) < 0.0018:
                    v = 0.9
            elif s > -0.003:
                v = 0.9                                       # raised frame around the panel
            # decorative strip under the panel
            if 0.042 < y < 0.066 and 0.045 < x < cw - 0.045:
                v = 0.8 if math.sin(x * 420) > 0.3 else 0.4
            k = (j * W + i) * 4
            buf[k] = buf[k + 1] = buf[k + 2] = v
            buf[k + 3] = 1.0
    img.pixels.foreach_set(buf)
    img.update()
    img.pack()
    return img


def make_leather(name, emboss, size):
    """size = (x, y, z) real size of the object in metres, so the grain has the right scale.
    The texture is glued to the surface (Generated coordinates), so it bends with the joints."""
    mat = new_material(name)
    nt = mat.node_tree
    out = node(nt, 'ShaderNodeOutputMaterial', 1500, 0)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 1200, 0)
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    tc = node(nt, 'ShaderNodeTexCoord', -1800, 0)
    gmap = node(nt, 'ShaderNodeMapping', -1600, -100, "Real-world size")
    link(nt, tc.outputs['Generated'], gmap.inputs['Vector'])
    gmap.inputs['Scale'].default_value = size
    coord = gmap.outputs['Vector']

    # --- big colour patches
    noise_big = node(nt, 'ShaderNodeTexNoise', -1300, 400, "Colour patches",
                     noise_dimensions='3D')
    noise_big.inputs['Scale'].default_value = 14
    noise_big.inputs['Detail'].default_value = 6
    noise_big.inputs['Roughness'].default_value = 0.6
    link(nt, coord, noise_big.inputs['Vector'])
    col_ramp = ramp(nt, -1050, 400, [(0.3, LEATHER_DARK), (0.7, LEATHER_LIGHT)], "Red-brown range")
    link(nt, noise_big.outputs['Fac'], col_ramp.inputs['Fac'])

    # --- pebbled grain (Voronoi cells)
    vor = node(nt, 'ShaderNodeTexVoronoi', -1300, 100, "Pebbled grain", feature='F1')
    vor.inputs['Scale'].default_value = GRAIN_SCALE
    link(nt, coord, vor.inputs['Vector'])
    pebble = ramp(nt, -1050, 100, [(0.0, (1, 1, 1, 1)), (0.7, (0, 0, 0, 1))], "Round pebbles")
    link(nt, vor.outputs['Distance'], pebble.inputs['Fac'])
    grain_bump = node(nt, 'ShaderNodeBump', 900, -300, "Grain bump")
    grain_bump.inputs['Strength'].default_value = GRAIN_STRENGTH
    grain_bump.inputs['Distance'].default_value = 0.001
    link(nt, pebble.outputs['Color'], grain_bump.inputs['Height'])

    # darken the gaps between pebbles
    shade = ramp(nt, -800, 100, [(0.0, (0.55, 0.55, 0.55, 1)), (1.0, (1, 1, 1, 1))], "Pebble shading")
    link(nt, pebble.outputs['Color'], shade.inputs['Fac'])
    m1 = mix_color(nt, -550, 300, 'MULTIPLY', 1.0)
    link(nt, col_ramp.outputs['Color'], m1.inputs[6])
    link(nt, shade.outputs['Color'], m1.inputs[7])
    last_color = m1.outputs[2]

    # --- worn, lighter edges using Ambient Occlusion
    ao = node(nt, 'ShaderNodeAmbientOcclusion', -1300, -250, "Edge detector (AO)")
    ao.samples = 16
    ao.inside = True
    ao.only_local = True
    ao.inputs['Distance'].default_value = WEAR_DISTANCE
    wear_ramp = ramp(nt, -1050, -250, [(0.30, (1, 1, 1, 1)), (0.85, (0, 0, 0, 1))], "Wear mask")
    link(nt, ao.outputs['AO'], wear_ramp.inputs['Fac'])
    noise_wear = node(nt, 'ShaderNodeTexNoise', -1300, -550, "Wear patchiness")
    noise_wear.inputs['Scale'].default_value = 90
    noise_wear.inputs['Detail'].default_value = 8
    link(nt, coord, noise_wear.inputs['Vector'])
    wear_noise_ramp = ramp(nt, -1050, -550, [(0.35, (0.2, 0.2, 0.2, 1)), (0.6, (1, 1, 1, 1))])
    link(nt, noise_wear.outputs['Fac'], wear_noise_ramp.inputs['Fac'])
    wear_mul = node(nt, 'ShaderNodeMath', -800, -350, "Wear x patchiness", operation='MULTIPLY')
    wear_mul.inputs[1].default_value = WEAR_AMOUNT
    wear_mul2 = node(nt, 'ShaderNodeMath', -800, -500, operation='MULTIPLY')
    link(nt, wear_ramp.outputs['Color'], wear_mul.inputs[0])
    link(nt, wear_noise_ramp.outputs['Color'], wear_mul2.inputs[0])
    link(nt, wear_mul.outputs[0], wear_mul2.inputs[1])
    m_wear = mix_color(nt, -300, 250, 'MIX', 0.0)
    m_wear.inputs[7].default_value = LEATHER_WORN
    link(nt, last_color, m_wear.inputs[6])
    link(nt, wear_mul2.outputs[0], m_wear.inputs[0])
    last_color = m_wear.outputs[2]

    # --- emboss (front cover only)
    normal_out = grain_bump.outputs['Normal']
    if emboss:
        # >>> WHERE TO LOAD YOUR OWN HEIGHT MAP <<<
        # Click the image-name field on the node called "EMBOSS HEIGHT MAP" in the Shader Editor
        # and open your own picture (it must stay set to Non-Color), or set HEIGHTMAP_PATH at the top.
        mapping = node(nt, 'ShaderNodeMapping', -1300, -900, "Emboss placement (move/scale here)")
        link(nt, tc.outputs['Generated'], mapping.inputs['Vector'])
        imgnode = node(nt, 'ShaderNodeTexImage', -1050, -900, "EMBOSS HEIGHT MAP")
        imgnode.image = make_emboss_image()     # (already set to Non-Color inside the function)
        imgnode.interpolation = 'Cubic'
        imgnode.extension = 'EXTEND'
        link(nt, mapping.outputs['Vector'], imgnode.inputs['Vector'])
        bw = node(nt, 'ShaderNodeRGBToBW', -780, -900)
        link(nt, imgnode.outputs['Color'], bw.inputs['Color'])
        # only emboss the outer (top) face: mask by object-space normal pointing up (+Z)
        sep = node(nt, 'ShaderNodeSeparateXYZ', -1050, -1150)
        link(nt, tc.outputs['Normal'], sep.inputs['Vector'])
        top_mask = node(nt, 'ShaderNodeMath', -800, -1150, "Top face mask", operation='GREATER_THAN')
        top_mask.inputs[1].default_value = 0.9
        link(nt, sep.outputs['Z'], top_mask.inputs[0])
        sub = node(nt, 'ShaderNodeMath', -560, -900, operation='SUBTRACT')
        sub.inputs[1].default_value = 0.5
        link(nt, bw.outputs['Val'], sub.inputs[0])
        height = node(nt, 'ShaderNodeMath', -330, -900, "Height (flat = 0.5)", operation='MULTIPLY_ADD')
        height.inputs[2].default_value = 0.5
        link(nt, sub.outputs[0], height.inputs[0])
        link(nt, top_mask.outputs[0], height.inputs[1])
        emb_bump = node(nt, 'ShaderNodeBump', 650, -700, "Emboss bump")
        emb_bump.inputs['Strength'].default_value = EMBOSS_STRENGTH
        emb_bump.inputs['Distance'].default_value = EMBOSS_DEPTH
        link(nt, height.outputs[0], emb_bump.inputs['Height'])
        link(nt, emb_bump.outputs['Normal'], grain_bump.inputs['Normal'])
        # darken the sunken parts a little so the relief reads in the colour too
        cav = ramp(nt, -100, -900, [(0.25, (0.45, 0.45, 0.45, 1)), (0.5, (1, 1, 1, 1))], "Sunken = darker")
        link(nt, height.outputs[0], cav.inputs['Fac'])
        m_cav = mix_color(nt, 150, 200, 'MULTIPLY', 1.0)
        link(nt, last_color, m_cav.inputs[6])
        link(nt, cav.outputs['Color'], m_cav.inputs[7])
        last_color = m_cav.outputs[2]

    link(nt, last_color, bsdf.inputs['Base Color'])
    link(nt, normal_out, bsdf.inputs['Normal'])

    # --- roughness variation (rougher where worn)
    noise_r = node(nt, 'ShaderNodeTexNoise', -1300, -1500, "Roughness variation")
    noise_r.inputs['Scale'].default_value = 40
    noise_r.inputs['Detail'].default_value = 5
    link(nt, coord, noise_r.inputs['Vector'])
    rough_ramp = ramp(nt, -1050, -1500, [(0.3, (0.38, 0.38, 0.38, 1)), (0.7, (0.62, 0.62, 0.62, 1))])
    link(nt, noise_r.outputs['Fac'], rough_ramp.inputs['Fac'])
    rough_add = node(nt, 'ShaderNodeMath', -750, -1500, "+ wear", operation='ADD')
    link(nt, rough_ramp.outputs['Color'], rough_add.inputs[0])
    wear_r = node(nt, 'ShaderNodeMath', -750, -1650, operation='MULTIPLY')
    wear_r.inputs[1].default_value = 0.2
    link(nt, wear_mul2.outputs[0], wear_r.inputs[0])
    link(nt, wear_r.outputs[0], rough_add.inputs[1])
    link(nt, rough_add.outputs[0], bsdf.inputs['Roughness'])

    # --- waxy clear coat (input names differ between versions)
    set_in(bsdf, ("Coat Weight", "Coat"), COAT_WEIGHT)
    set_in(bsdf, ("Coat Roughness",), COAT_ROUGHNESS)
    set_in(bsdf, ("Specular IOR Level", "Specular"), 0.4)
    return mat


def make_paper():
    """Cream paper. Every sheet is a separate object, so each one gets its own slightly
    different shade (Object Info > Random) - this is what makes the stack look like real pages."""
    mat = new_material("Paper")
    nt = mat.node_tree
    out = node(nt, 'ShaderNodeOutputMaterial', 700, 0)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 400, 0)
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    info = node(nt, 'ShaderNodeObjectInfo', -300, 0, "Random per sheet")
    cr = ramp(nt, 0, 0, [(0.0, PAPER_DARK), (1.0, PAPER_LIGHT)], "Cream range")
    link(nt, info.outputs['Random'], cr.inputs['Fac'])
    paper_col = cr.outputs['Color']
    if TEXT_ON:
        # --- printed text: lines (Wave texture) broken into words (Noise), inside page margins
        tc = node(nt, 'ShaderNodeTexCoord', -1500, -400)
        m_lines = node(nt, 'ShaderNodeMapping', -1300, -300, "Page size (metres)")
        m_lines.inputs['Scale'].default_value = (BOOK_W, BOOK_H, 1.0)
        link(nt, tc.outputs['UV'], m_lines.inputs['Vector'])
        wave = node(nt, 'ShaderNodeTexWave', -1050, -250, "Lines of text", wave_type='BANDS',
                    bands_direction='Y', wave_profile='SIN')
        wave.inputs['Scale'].default_value = 70
        link(nt, m_lines.outputs['Vector'], wave.inputs['Vector'])
        lines = ramp(nt, -800, -250, [(0.90, (0, 0, 0, 1)), (0.94, (1, 1, 1, 1))], "Thin lines")
        link(nt, wave.outputs['Fac'], lines.inputs['Fac'])
        m_words = node(nt, 'ShaderNodeMapping', -1300, -650, "Word size")
        m_words.inputs['Scale'].default_value = (12.5, 110.0, 1.0)
        link(nt, tc.outputs['UV'], m_words.inputs['Vector'])
        noise = node(nt, 'ShaderNodeTexNoise', -1050, -650, "Words", noise_dimensions='3D')
        noise.inputs['Scale'].default_value = 1.0
        noise.inputs['Detail'].default_value = 0.0
        link(nt, m_words.outputs['Vector'], noise.inputs['Vector'])
        words = ramp(nt, -800, -650, [(0.34, (0, 0, 0, 1)), (0.38, (1, 1, 1, 1))], "Words / gaps")
        link(nt, noise.outputs['Fac'], words.inputs['Fac'])
        # margins: only print inside a box on the page
        sep = node(nt, 'ShaderNodeSeparateXYZ', -1050, -950)
        link(nt, tc.outputs['UV'], sep.inputs['Vector'])
        prev = None
        for axis, lo, hi in (('X', 0.11, 0.89), ('Y', 0.07, 0.93)):
            g = node(nt, 'ShaderNodeMath', -800, -950 - (60 if axis == 'Y' else 0), operation='GREATER_THAN')
            g.inputs[1].default_value = lo
            l = node(nt, 'ShaderNodeMath', -620, -950 - (60 if axis == 'Y' else 0), operation='LESS_THAN')
            l.inputs[1].default_value = hi
            link(nt, sep.outputs[axis], g.inputs[0])
            link(nt, sep.outputs[axis], l.inputs[0])
            both = node(nt, 'ShaderNodeMath', -440, -950 - (60 if axis == 'Y' else 0), operation='MULTIPLY')
            link(nt, g.outputs[0], both.inputs[0])
            link(nt, l.outputs[0], both.inputs[1])
            if prev is None:
                prev = both
            else:
                box = node(nt, 'ShaderNodeMath', -260, -950, "Inside margins", operation='MULTIPLY')
                link(nt, prev.outputs[0], box.inputs[0])
                link(nt, both.outputs[0], box.inputs[1])
                prev = box
        t1 = node(nt, 'ShaderNodeMath', -120, -450, operation='MULTIPLY')
        link(nt, lines.outputs['Color'], t1.inputs[0])
        link(nt, words.outputs['Color'], t1.inputs[1])
        t2 = node(nt, 'ShaderNodeMath', 60, -450, "Ink amount", operation='MULTIPLY')
        t2.inputs[1].default_value = 0.0
        link(nt, t1.outputs[0], t2.inputs[0])
        link(nt, prev.outputs[0], t2.inputs[1])
        ink_mix = mix_color(nt, 250, 100, 'MIX', 0.0)
        ink_mix.inputs[7].default_value = (0.12, 0.10, 0.09, 1)        # ink colour
        link(nt, paper_col, ink_mix.inputs[6])
        ink_fac = node(nt, 'ShaderNodeMath', 150, -450, "Ink strength", operation='MULTIPLY')
        ink_fac.inputs[1].default_value = 0.8
        link(nt, t2.outputs[0], ink_fac.inputs[0])
        link(nt, ink_fac.outputs[0], ink_mix.inputs[0])
        paper_col = ink_mix.outputs[2]
    link(nt, paper_col, bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    set_in(bsdf, ("Subsurface Weight", "Subsurface"), 0.05)
    return mat


def make_fabric_mat():
    mat = new_material("Fabric")
    nt = mat.node_tree
    out = node(nt, 'ShaderNodeOutputMaterial', 900, 0)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 600, 0)
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    tc = node(nt, 'ShaderNodeTexCoord', -1000, 0)
    gmap = node(nt, 'ShaderNodeMapping', -800, 0, "Real-world size")
    link(nt, tc.outputs['UV'], gmap.inputs['Vector'])
    gmap.inputs['Scale'].default_value = (FABRIC_W, BOOK_H, 1.0)
    wx = node(nt, 'ShaderNodeTexWave', -500, 150, "Threads along X", wave_type='BANDS',
              bands_direction='X', wave_profile='SIN')
    wy = node(nt, 'ShaderNodeTexWave', -500, -150, "Threads along Y", wave_type='BANDS',
              bands_direction='Y', wave_profile='SIN')
    for w in (wx, wy):
        w.inputs['Scale'].default_value = 500
        w.inputs['Distortion'].default_value = 0.6
        link(nt, gmap.outputs['Vector'], w.inputs['Vector'])
    weave = node(nt, 'ShaderNodeMath', -250, 0, "Weave", operation='ADD')
    link(nt, wx.outputs['Fac'], weave.inputs[0])
    link(nt, wy.outputs['Fac'], weave.inputs[1])
    dark = tuple(c * 0.7 for c in FABRIC_COLOR[:3]) + (1,)
    cr = ramp(nt, 0, 150, [(0.3, dark), (1.4, FABRIC_COLOR)])
    link(nt, weave.outputs[0], cr.inputs['Fac'])
    link(nt, cr.outputs['Color'], bsdf.inputs['Base Color'])
    bump = node(nt, 'ShaderNodeBump', 300, -200, "Weave bump")
    bump.inputs['Strength'].default_value = 0.5
    bump.inputs['Distance'].default_value = 0.0004
    link(nt, weave.outputs[0], bump.inputs['Height'])
    link(nt, bump.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.9
    set_in(bsdf, ("Sheen Weight", "Sheen"), 0.4)
    return mat


def make_simple(name, color, rough, metallic=0.0):
    mat = new_material(name)
    nt = mat.node_tree
    out = node(nt, 'ShaderNodeOutputMaterial', 400, 0)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 100, 0)
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


# =============================================================================
# 5. BUILD THE BOOK
# =============================================================================
cleanup()
coll = bpy.data.collections.new(COLL_NAME)
scene.collection.children.link(coll)

mat_leather_front = make_leather("Leather_Front", True, (COV_W, COV_H, CT))
mat_leather = make_leather("Leather", False, (COV_W, COV_H, CT))
mat_leather_spine = make_leather("Leather_Spine", False, (CT, COV_H, SPINE_L))
mat_leather_joint = make_leather("Leather_Joint", False, (JOINT_L, CT, COV_H))
mat_paper = make_paper()
mat_thread = make_simple("Thread", THREAD_COLOR, 0.7)
mat_brass = make_simple("Brass", PLATE_COLOR, 0.3, metallic=1.0)

# --- the control: ONE number (0 = closed, 1 = open) that drives everything
ctl = bpy.data.objects.new("BookOpen", None)
ctl.empty_display_type = 'ARROWS'
ctl.empty_display_size = 0.03
ctl.location = (0.0, -0.05, 0.0)
coll.objects.link(ctl)
ctl["open"] = 0.0
try:
    ctl.id_properties_ui("open").update(min=0.0, max=1.0)
except Exception:
    pass

# --- the pages: every sheet is its own object. Two empties act as folders for each stack.
pages_right = bpy.data.objects.new("Pages_Right", None)      # holds the right-hand stack
pages_left = bpy.data.objects.new("Pages_Left", None)        # holds the left-hand stack (rides on the front cover)
for pe in (pages_right, pages_left):
    pe.empty_display_type = 'PLAIN_AXES'
    pe.empty_display_size = 0.01
    coll.objects.link(pe)
sheets_r, sheets_l, shape_keys = [], [], []
for i in range(N):
    for mirror, lst, prefix in ((False, sheets_r, "Page_R_"), (True, sheets_l, "Page_L_")):
        sh, sk = make_sheet(f"{prefix}{i + 1:02d}", mirror, i, coll)
        if hasattr(sh.data, "shade_smooth"):
            sh.data.shade_smooth()
        sol = sh.modifiers.new("Thickness", 'SOLIDIFY')
        sol.thickness = PAGE_THICKNESS
        sol.offset = 0
        sh.data.materials.append(mat_paper)
        lst.append(sh)
        shape_keys.append(sk)

# --- cloth hinge strip lying on the middle sheets next to the centre fold
fabric_l = None
if FABRIC_ON:
    mat_fabric = make_fabric_mat()
    for nm, mirror in (("Fabric_R", False), ("Fabric_L", True)):
        fab, fsk = make_fabric(nm, mirror, coll)
        shape_keys.append(fsk)
        if hasattr(fab.data, "shade_smooth"):
            fab.data.shade_smooth()
        uvl = fab.data.uv_layers.new(name="UVMap")
        n_cols = len(fab.data.vertices) // 2 - 1
        for poly in fab.data.polygons:
            for li in poly.loop_indices:
                vi = fab.data.loops[li].vertex_index
                uvl.data[li].uv = ((vi // 2) / n_cols, (vi % 2))
        sol = fab.modifiers.new("Thickness", 'SOLIDIFY')
        sol.thickness = 0.0003
        sol.offset = 0
        fab.data.materials.append(mat_fabric)
        if mirror:
            fabric_l = fab

# --- the back cover (fixed) and the HARD spine
back = make_box("BackCover", (0, -OVERHANG, 0), (COV_W, BOOK_H + OVERHANG, CT), coll)
smooth_and_bevel(back, COVER_BEVEL, 3)
back.data.materials.append(mat_leather)

# The spine is a stiff piece. It turns around the hinge line P1 (where the back cover meets it).
P1 = Vector((-RJ, 0, CT / 2))
spine_x = -RJ                                             # centre line of the spine wall
spine_z0, spine_z1 = CT / 2 + RJ, TOTAL_T - CT / 2 - RJ  # bottom / top of the spine wall
spine = make_box("Spine", (spine_x - CT / 2, -OVERHANG, spine_z0), (spine_x + CT / 2, BOOK_H + OVERHANG, spine_z1),
                 coll, origin=P1)
smooth_and_bevel(spine, COVER_BEVEL, 3)
spine.data.materials.append(mat_leather_spine)

# --- raised bands across the spine (part of the hard spine)
bands = []
for i in range(BAND_COUNT):
    yc = BOOK_H * (0.12 + 0.76 * i / (BAND_COUNT - 1)) if BAND_COUNT > 1 else BOOK_H / 2
    b = make_box(f"SpineBand_{i + 1}",
                 (spine_x - CT / 2 - BAND_HEIGHT, yc - BAND_W / 2, spine_z0 + 0.0005),
                 (spine_x - CT / 2 + 0.0005, yc + BAND_W / 2, spine_z1 - 0.0005), coll)
    smooth_and_bevel(b, 0.0008, 2)
    b.data.materials.append(mat_leather_spine)
    bands.append(b)

# --- the front cover. It turns around the hinge line P2 where it meets the spine.
P2 = Vector((-RJ, 0, TOTAL_T - CT / 2))
front = make_box("FrontCover", (0, -OVERHANG, TOTAL_T - CT), (COV_W, BOOK_H + OVERHANG, TOTAL_T),
                 coll, origin=P2)
smooth_and_bevel(front, COVER_BEVEL, 3)
front.data.materials.append(mat_leather_front)

# --- title plate (brass) on the front cover
plate = None
if TITLE_PLATE:
    pw, ph = PLATE_SIZE
    plate = make_box("TitlePlate", (COV_W / 2 - pw / 2, PLATE_Y - ph / 2, TOTAL_T),
                     (COV_W / 2 + pw / 2, PLATE_Y + ph / 2, TOTAL_T + 0.0007), coll)
    smooth_and_bevel(plate, 0.0002, 2)
    plate.data.materials.append(mat_brass)

# --- stitched border (real geometry, one object made of many tiny stitches)
stitches = None
if STITCHES:
    origin = Vector((0, 0, MID))
    bm = bmesh.new()
    x0, x1 = STITCH_INSET, COV_W - STITCH_INSET
    y0, y1 = -OVERHANG + STITCH_INSET, BOOK_H + OVERHANG - STITCH_INSET
    rot = Matrix.Rotation(math.radians(STITCH_ANGLE), 4, 'Z')
    scale = Matrix.Diagonal((STITCH_LEN, STITCH_WIDTH, STITCH_WIDTH, 1))
    zst = TOTAL_T - 0.0002

    def add_line(p_a, p_b):
        length = (Vector(p_b) - Vector(p_a)).length
        n = max(2, round(length / STITCH_STEP))
        for k in range(n):
            t = (k + 0.5) / n
            pos = Vector(p_a).lerp(Vector(p_b), t)
            M = Matrix.Translation(Vector((pos.x, pos.y, zst)) - origin) @ rot @ scale
            bmesh.ops.create_cube(bm, size=1.0, matrix=M)
    add_line((x0, y0), (x1, y0))
    add_line((x1, y0), (x1, y1))
    add_line((x1, y1), (x0, y1))
    add_line((x0, y1), (x0, y0))
    me = bpy.data.meshes.new("Stitches")
    bm.to_mesh(me)
    bm.free()
    stitches = bpy.data.objects.new("Stitches", me)
    stitches.location = origin
    coll.objects.link(stitches)
    smooth_and_bevel(stitches, 0.0003, 2)
    stitches.data.materials.append(mat_thread)

# --- the two bendy JOINT strips (the only parts of the case that bend)
# Each strip is a flat piece of leather that follows a curve between two "anchor" points.
# The anchors are little empties stuck to the hard parts, so the strip always joins them up.
KH = 0.5523 * RJ                                          # how rounded the bend is


def make_anchor(name, pos):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = 'SPHERE'
    e.empty_display_size = 0.002
    e.location = pos
    coll.objects.link(e)
    return e


def make_joint(name):
    """Joint strip mesh + its curve. Built in a turned frame so the curve lives in the flat XY plane:
    strip x = along the curve, y = leather thickness (+y is outside), z = along the book height."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((JOINT_L / 2, 0, -BOOK_H / 2))
                          @ Matrix.Diagonal((JOINT_L, CT, COV_H, 1)))
    for i in range(1, 24):
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=0.0,
                               plane_co=(JOINT_L * i / 24, 0, 0), plane_no=(1, 0, 0))
    jme = bpy.data.meshes.new(name)
    bm.to_mesh(jme)
    bm.free()
    jo = bpy.data.objects.new(name, jme)
    jo.rotation_euler = SPINE_ROT
    coll.objects.link(jo)
    cu = bpy.data.curves.new(name + "_Curve", 'CURVE')
    cu.dimensions = '2D'
    cu.resolution_u = 24
    cu.use_path = True
    cu.use_stretch = True            # the strip stretches to always fit between its two anchors
    cu.use_deform_bounds = True
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(1)
    for bp in sp.bezier_points:
        bp.handle_left_type = 'FREE'
        bp.handle_right_type = 'FREE'
    co = bpy.data.objects.new(name + "_Curve", cu)
    co.rotation_euler = SPINE_ROT
    co.hide_render = True
    coll.objects.link(co)
    cm = jo.modifiers.new("Curve", 'CURVE')
    cm.object = co
    cm.deform_axis = 'POS_X'
    smooth_and_bevel(jo, COVER_BEVEL, 3)
    jo.data.materials.append(mat_leather_joint)
    return jo, co, sp.bezier_points[0], sp.bezier_points[1]


jb, jb_curve, jb0, jb1 = make_joint("Joint_Back")
jf, jf_curve, jf0, jf1 = make_joint("Joint_Front")

# anchor points (world positions of the closed book, in the x/z plane)
A = (0.0, CT / 2)                                        # inner edge of the back cover (never moves)
B = (-RJ, CT / 2 + RJ)                                   # bottom end of the spine
C = (-RJ, TOTAL_T - CT / 2 - RJ)                         # top end of the spine
D = (0.0, TOTAL_T - CT / 2)                              # inner edge of the front cover
anc_B = make_anchor("Anchor_B", (B[0], 0, B[1]))
anc_Bh = make_anchor("Anchor_B_handle", (B[0], 0, B[1] - KH))
anc_C = make_anchor("Anchor_C", (C[0], 0, C[1]))
anc_Ch = make_anchor("Anchor_C_handle", (C[0], 0, C[1] + KH))
anc_D = make_anchor("Anchor_D", (D[0], 0, D[1]))
anc_Dh = make_anchor("Anchor_D_handle", (D[0] - KH, 0, D[1]))

# =============================================================================
# 6. HINGE CHAIN + PARENTING + ANIMATION
# =============================================================================
bpy.context.view_layer.update()


def adopt(child, parent):
    """Parent keep transform: the child stays exactly where it is, but now follows the parent."""
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


for b in bands:                       # bands and the spine's anchors ride on the hard spine
    adopt(b, spine)
for e in (anc_B, anc_Bh, anc_C, anc_Ch):
    adopt(e, spine)
adopt(front, spine)                   # the front cover hangs off the spine's top hinge
bpy.context.view_layer.update()
adopt(anc_D, front)
adopt(anc_Dh, front)
adopt(pages_left, front)              # the left-hand page stack is carried by the front cover
bpy.context.view_layer.update()
for sh in sheets_l:
    adopt(sh, pages_left)
for sh in sheets_r:
    adopt(sh, pages_right)
for child in (fabric_l, plate, stitches):
    if child is not None:
        adopt(child, front)

# Both hinges turn the same amount: 90 degrees (negative = lifts UP and over).
spine.rotation_mode = 'XYZ'
front.rotation_mode = 'XYZ'
add_driver(spine, "rotation_euler", 1, "-1.5707963*o", ctl)
add_driver(front, "rotation_euler", 1, "-1.5707963*o", ctl)
# Every sheet (and the cloth) curves open together with the covers.
for sk in shape_keys:
    add_driver(sk, "value", -1, "o", ctl)

# Joint curves: their end points follow the anchors.
jb0.co = (A[0], A[1], 0.0)
jb0.handle_left = jb0.co
jb0.handle_right = (A[0] - KH, A[1], 0.0)
for idx, ax in ((0, 'LOC_X'), (1, 'LOC_Z')):
    follow_empty(jb1, "co", idx, anc_B, ax)
    follow_empty(jb1, "handle_left", idx, anc_Bh, ax)
    follow_empty(jf0, "co", idx, anc_C, ax)
    follow_empty(jf0, "handle_right", idx, anc_Ch, ax)
    follow_empty(jf1, "co", idx, anc_D, ax)
    follow_empty(jf1, "handle_left", idx, anc_Dh, ax)
jb1.handle_right = jb1.co
jf0.handle_left = jf0.co
jf1.handle_right = jf1.co

# Keyframes on the one control number (this is the animation you can see and edit)
scene.frame_start = FRAME_START
scene.frame_end = FRAME_END
ctl["open"] = 0.0
ctl.keyframe_insert('["open"]', frame=FRAME_START)
ctl["open"] = 1.0
ctl.keyframe_insert('["open"]', frame=FRAME_END)


def iter_fcurves(action):
    if hasattr(action, "fcurves"):                 # Blender 4.x
        yield from action.fcurves
    else:                                          # Blender 4.4+ / 5.x layered actions
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    yield from bag.fcurves


try:
    for fc in iter_fcurves(ctl.animation_data.action):
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'            # smooth curve instead of straight line
            kp.handle_left_type = 'AUTO_CLAMPED'   # eases in and out (slow start, slow stop)
            kp.handle_right_type = 'AUTO_CLAMPED'
except Exception as e:
    print("Could not set easing:", e)
try:
    for o in (jb_curve, jf_curve, anc_B, anc_Bh, anc_C, anc_Ch, anc_D, anc_Dh):
        o.hide_set(True)                           # helper objects: hide them from the viewport
except Exception:
    pass
scene.frame_set(FRAME_START)

# =============================================================================
# 7. SCENE: floor, camera, lights, world, render settings
# =============================================================================
# --- floor
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=3.0)
fme = bpy.data.meshes.new("Floor")
bm.to_mesh(fme)
bm.free()
floor = bpy.data.objects.new("Floor", fme)
floor.location = (0, 0, -0.0003)
coll.objects.link(floor)
floor.data.materials.append(make_simple("Floor", (0.03, 0.028, 0.03, 1), 0.45))

# --- camera that always points at CAM_TARGET
target = bpy.data.objects.new("CameraTarget", None)
target.location = CAM_TARGET
coll.objects.link(target)
cam_data = bpy.data.cameras.new("Camera")
cam_data.lens = CAM_LENS
cam_data.clip_start = 0.01
cam = bpy.data.objects.new("Camera", cam_data)
cam.location = CAM_LOCATION
coll.objects.link(cam)
tr = cam.constraints.new('TRACK_TO')
tr.target = target
tr.track_axis = 'TRACK_NEGATIVE_Z'
tr.up_axis = 'UP_Y'
scene.camera = cam


def add_light(name, loc, color, power, size):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = power
    ld.color = color[:3]
    ld.size = size
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    coll.objects.link(lo)
    c = lo.constraints.new('TRACK_TO')
    c.target = target
    c.track_axis = 'TRACK_NEGATIVE_Z'
    c.up_axis = 'UP_Y'
    return lo


add_light("Key_Warm", (0.45, -0.30, 0.50), KEY_COLOR, KEY_POWER, 0.35)
add_light("Fill_Cool", (-0.50, -0.25, 0.25), FILL_COLOR, FILL_POWER, 0.5)
add_light("Rim_Warm", (-0.10, 0.60, 0.35), KEY_COLOR, RIM_POWER, 0.3)

# --- dark world background
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
try:
    world.use_nodes = True
except Exception:
    pass
bg = world.node_tree.nodes.get("Background")
if bg:
    bg.inputs['Color'].default_value = BACKGROUND
    bg.inputs['Strength'].default_value = 1.0

# --- render settings
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0
scene.render.engine = 'CYCLES'
scene.cycles.samples = RENDER_SAMPLES
scene.cycles.preview_samples = PREVIEW_SAMPLES
scene.cycles.use_denoising = True
scene.cycles.use_preview_denoising = True
try:
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
except Exception:
    pass
scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.resolution_percentage = 100

# --- show the camera view in the 3D viewport (skipped if there is no window, e.g. background mode)
try:
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                sp = area.spaces[0]
                sp.shading.type = 'MATERIAL'       # quick preview; switch to 'RENDERED' for Cycles
                sp.region_3d.view_perspective = 'CAMERA'
                sp.clip_start = 0.001
except Exception:
    pass

print("Leather book built. Press SPACE in the 3D viewport to play the animation.")
