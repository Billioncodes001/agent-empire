"""Rebuild the authored sedan with wheel arches, articulated running gear and a detailed cabin.
Run with Blender 4.5: blender -b --python tools/refine-sedan.py
"""
import bpy, math, bmesh
from pathlib import Path
from mathutils import Vector
BASE=Path(__file__).resolve().parent
bpy.ops.wm.read_factory_settings(use_empty=True)
# The original body tooling remains reproducible; reuse it without the studio or export.
exec((BASE/'build-sedan.py').read_text().split("ground=mat")[0])
exec((BASE/'add-sedan-door.py').read_text().split("scene=bpy.context.scene")[0])
root=bpy.data.objects['Executive_Sedan']
for o in list(bpy.data.objects):
    o.animation_data_clear()
for m in list(bpy.data.materials):
    bs=m.node_tree.nodes.get('Principled BSDF') if m.use_nodes else None
    if bs and m.name=='Midnight graphite metallic':
        bs.inputs['Base Color'].default_value=(.035,.065,.095,1);bs.inputs['Roughness'].default_value=.29;bs.inputs['Coat Weight'].default_value=.48
    if bs and m.name=='Smoked panoramic glass':
        bs.inputs['Base Color'].default_value=(.075,.11,.14,1);bs.inputs['Roughness'].default_value=.13;bs.inputs['Metallic'].default_value=.12
# Keep transforms local to named articulations. Export converts Z-up Blender to Y-up glTF.
def parent_keep(o,parent):
    bpy.context.view_layer.update(); world=o.matrix_world.copy();o.parent=parent;o.matrix_world=world

def empty(name,loc,parent=root):
    o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.location=loc;o.parent=parent;return o

def solid(name,loc,dim,material,bevel=.015,parent=root):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=dim
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material)
    if bevel:
        mod=o.modifiers.new('Edge radius','BEVEL');mod.width=bevel;mod.segments=3
        o.modifiers.new('Normals','WEIGHTED_NORMAL')
    parent_keep(o,parent);return o

def line(name,points,material,radius=.009,parent=root):
    c=bpy.data.curves.new(name,'CURVE');c.dimensions='3D';c.bevel_depth=radius;c.bevel_resolution=2
    sp=c.splines.new('POLY');sp.points.add(len(points)-1)
    for p,v in zip(sp.points,points):p.co=(*v,1)
    o=bpy.data.objects.new(name,c);bpy.context.collection.objects.link(o);o.data.materials.append(material);parent_keep(o,parent);return o
handle=empty('Driver_handle',(.95,.35,.96));parent_keep(handle,bpy.data.objects['Driver_door_hinge'])
body=bpy.data.objects['Sculpted aluminium body'];door=bpy.data.objects['Driver_door_panel']
# The footwell floor sits below the soles; the original shallow cut left a solid block under the pedals.
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,.02,.94));tool=bpy.context.object;tool.dimensions=(1.58,2.22,1.42)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
for o in [body,door]:
    bpy.context.view_layer.objects.active=o
    mod=o.modifiers.new('Deep passenger footwell','BOOLEAN');mod.object=tool;mod.operation='DIFFERENCE';bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.data.objects.remove(tool,do_unlink=True)
# Glazing is a surface, not a translucent solid block with a glass floor or tooling end caps.
for o in [bpy.data.objects['Glazed cabin'],bpy.data.objects['Driver_door_window']]:
    bm=bmesh.new();bm.from_mesh(o.data)
    remove=[]
    for f in bm.faces:
        points=[o.matrix_world @ v.co for v in f.verts]
        cap=any(all(abs(p[axis]-value)<.001 for p in points) for axis,value in [(0,.54),(1,-.41),(1,1.11)])
        if cap or max(p.z for p in points)<1.01:remove.append(f)
    bmesh.ops.delete(bm,geom=remove,context='FACES');bm.to_mesh(o.data);bm.free()
for y in [-1.45,1.45]:
    bpy.ops.mesh.primitive_cylinder_add(vertices=64,radius=.418,depth=3,location=(0,y,.37),rotation=(0,math.pi/2,0));tool=bpy.context.object
    for o in [body,door]:
        bpy.context.view_layer.objects.active=o
        mod=o.modifiers.new('True wheel arch','BOOLEAN');mod.object=tool;mod.operation='DIFFERENCE';bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(tool,do_unlink=True)
# Dark wheel housings and a fine painted lip around the wheel opening.
for side in [-1,1]:
    for y in [-1.45,1.45]:
        line('Fender lip',[(side*.921,y+math.cos(a)*.42,.37+math.sin(a)*.42) for a in [i*math.pi/32 for i in range(33)]],paint,.016)
    line('Rear door shutline',[(side*.938,-.08,.44),(side*.939,-.08,.97),(side*.708,-.08,1.43)],dark,.006)
    line('Rear quarter shutline',[(side*.91,-1.05,.74),(side*.923,-.85,.99),(side*.70,-.79,1.38)],dark,.006)
    line('Window brightwork',[(side*.67,-1.18,1.0),(side*.70,-.8,1.39),(side*.70,-.3,1.53),(side*.66,.45,1.49),(side*.63,1.13,1.01)],chrome,.012)
    line('A pillar',[(side*.64,1.1,1.01),(side*.66,.47,1.49)],paint,.034)
    line('C pillar',[(side*.67,-1.2,1.0),(side*.70,-.82,1.4)],paint,.038)
    line('Hood seam',[(side*.65,1.18,.99),(side*.69,1.75,.88),(side*.65,2.19,.75)],dark,.005)
    solid('Lower side vent',(side*.926,.88,.58),(.018,.21,.075),dark,.008)
# Refined wheels with brake discs and calipers, grouped into independent steer/spin pivots.
for side in [-1,1]:
    for y in [-1.45,1.45]:
        # Blender +X becomes the driver's left after the game rotates the model to face +Z.
        id=('F' if y>0 else 'R')+('L' if side>0 else 'R')
        steering=empty('Wheel_'+id,(side*.91,y,.37));spin=empty('Spin_'+id,(0,0,0),steering)
        for o in list(root.children):
            if o.name.startswith(('Tire','Alloy wheel','Machined spoke','Wheel bolt')) and abs(o.location.y-y)<.3 and o.location.x*side>0:
                parent_keep(o,spin)
        bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.205,depth=.016,location=(side*.976,y,.37),rotation=(0,math.pi/2,0))
        disc=bpy.context.object;disc.name='Brake disc';disc.data.materials.append(chrome);parent_keep(disc,spin)
        solid('Brake caliper',(side*.98,y+.16,.41),(.046,.085,.16),dark,.016,steering)
        # Circumferential grooves catch light without adding a noisy tread texture.
        for x in [-.043,.043]:
            bpy.ops.mesh.primitive_torus_add(major_radius=.359,minor_radius=.007,major_segments=64,minor_segments=6,location=(side*.91+x,y,.37),rotation=(0,math.pi/2,0))
            o=bpy.context.object;o.name='Tread groove';o.data.materials.append(dark);parent_keep(o,spin)
# Cabin fixtures and a readable first-person dashboard.
leather=mat('Graphite leather',(.028,.031,.034),.05,.67)
screen=mat('Dashboard display',(.008,.016,.022),.0,.2)
bs=screen.node_tree.nodes.get('Principled BSDF');bs.inputs['Emission Color'].default_value=(.08,.24,.31,1);bs.inputs['Emission Strength'].default_value=.12
solid('Center console',(0,.12,.64),(.28,1.13,.25),leather,.04)
solid('Rear bench',(0,-.87,.6),(1.3,.43,.18),leather,.05)
solid('Rear seatback',(0,-1.04,.91),(1.3,.11,.49),leather,.045)
solid('Instrument binnacle',(.43,.91,1.065),(.47,.07,.22),dark,.028)
solid('Instrument display',(.43,.868,1.065),(.41,.01,.16),screen,.007)
solid('Center touch display',(0,.78,1.045),(.32,.025,.19),screen,.012)
for x in [-.57,.57]:solid('Air vent',(x,.698,.885),(.17,.018,.07),chrome,.008)
for x in [-.45,.45]:line('Seat stitching',[(x-.22,-.37,.68),(x-.22,-.42,1.16),(x+.22,-.42,1.16),(x+.22,-.37,.68)],chrome,.002)
wheel=bpy.data.objects['Steering wheel'];wheel.location.z-=.09;control=empty('Steering_control',tuple(wheel.location));parent_keep(wheel,control)
solid('Steering hub',(.43,.62,.90),(.13,.045,.1),leather,.03,control)
for side in [-1,1]:line('Steering spoke',[(.43+side*.04,.62,.90),(.43+side*.147,.62,.945)],chrome,.015,control)
# Lamp materials are independently dimmed by running / braking state in Three.js.
brake=mat('Brake lamp',(.34,.006,.009),.2,.2);bs=brake.node_tree.nodes.get('Principled BSDF');bs.inputs['Emission Color'].default_value=(1,.014,.018,1);bs.inputs['Emission Strength'].default_value=.35
for o in root.children_recursive:
    if o.name.startswith('Red tail light'):o.data.materials.clear();o.data.materials.append(brake)
solid('High mounted brake lamp',(0,-1.14,1.045),(.34,.025,.022),brake,.008)
solid('Plate surround',(0,-2.332,.61),(.46,.015,.14),dark,.01)
solid('Rear plate',(0,-2.344,.61),(.39,.009,.09),white,.003)
# Geometry follows the body; wheel contacts remain on the road.
sprung=empty('Sprung_body',(0,0,0))
for o in list(root.children):
    if o!=sprung and not o.name.startswith('Wheel_'):parent_keep(o,sprung)
# Apply modelling modifiers and batch fixtures by material within each articulation.
bpy.ops.object.select_all(action='DESELECT')
for o in list(root.children_recursive):
    if o.type=='CURVE':
        o.select_set(True);bpy.context.view_layer.objects.active=o;bpy.ops.object.convert(target='MESH');o.select_set(False)
    if o.type=='MESH':
        bpy.context.view_layer.objects.active=o
        for mod in list(o.modifiers):
            try:bpy.ops.object.modifier_apply(modifier=mod.name)
            except RuntimeError:pass
# Preserve important door / wheel / steering nodes while merging trim draw calls.
for parent in [sprung]+[o for o in root.children_recursive if o.type=='EMPTY']:
    groups={}
    for o in list(parent.children):
        if o.type=='MESH' and o.name not in ['Driver_door_panel','Driver_door_window','Steering wheel']:
            key=tuple(m.name for m in o.data.materials);groups.setdefault(key,[]).append(o)
    for objects in groups.values():
        if len(objects)<2:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join()
        objects[0].name=parent.name+'_fixtures_'+objects[0].data.materials[0].name.replace(' ','_')
bpy.ops.object.select_all(action='DESELECT');root.select_set(True)
for o in root.children_recursive:o.select_set(True)
output=BASE.parent/'src/client/public/models/executive-sedan.glb'
bpy.ops.export_scene.gltf(filepath=str(output),use_selection=True,export_animations=False)
print('Exported articulated sedan',output)
