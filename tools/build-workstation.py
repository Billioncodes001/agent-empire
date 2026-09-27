"""Create an original, metre-scale workstation accessory asset in Blender 4.5+."""
import bpy, math, sys
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
def material(name, color, metallic=0, roughness=.4, emission=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Metallic'].default_value=metallic;bs.inputs['Roughness'].default_value=roughness
 if emission:bs.inputs['Emission Color'].default_value=(*color,1);bs.inputs['Emission Strength'].default_value=emission
 return m
metal=material('Brushed graphite',(.10,.12,.13),.8,.28)
black=material('Monitor polymer',(.023,.03,.033),.15,.33)
screen=material('Display standby',(.035,.095,.12),.18,.26,.45)
light=material('Power LED',(.28,.8,.65),0,.2,1.6)
def cube(name, size, pos, mat, bevel=.008):
 bpy.ops.mesh.primitive_cube_add(size=1,location=(pos[0],-pos[2],pos[1]));o=bpy.context.object;o.name=name;o.dimensions=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat)
 if bevel:
  b=o.modifiers.new('Machined edge','BEVEL');b.width=bevel;b.segments=3
  o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
 return o
for side in [-1,1]:
 x=side*.47
 cube('Monitor chassis',(.90,.52,.045),(x,1.20,-.36),black,.012)
 cube('MonitorScreen',(.862,.477,.008),(x,1.205,-.333),screen,.003)
 cube('Lower bezel',(.9,.025,.011),(x,.948,-.331),metal,.002)
 cube('Power indicator',(.012,.004,.004),(x+.38,.948,-.323),light,.001)
 cube('Display stand',(.043,.19,.038),(x,.876,-.38),metal,.004)
 cube('Stand foot',(.30,.014,.22),(x,.791,-.35),metal,.01)
# Under-desk workstation with front ventilation and status LED.
cube('Computer tower',(.23,.43,.42),(.83,.25,.05),black,.018)
for z in range(9):cube('Vent',(.18,.011,.006),(.83,.16+z*.022,.264),metal,.002)
cube('Computer power',(.016,.016,.005),(.90,.414,.267),light,.002)
cube('Docking hub',(.21,.045,.09),(-.72,.812,.36),metal,.01)
for x in [-.055,0,.055]:cube('Dock port',(.031,.01,.005),(-.72+x,.814,.408),black,.001)
cube('Keyboard',(.65,.021,.245),(0,.801,.255),metal,.009)
for row in range(5):
 for col in range(14):
  cube('Keycap',(.036,.009,.034),(-.287+col*.044,.818,.16+row*.044),black,.002)
cube('Space bar',(.245,.009,.029),(0,.819,.361),black,.002)
cube('Mouse',(.067,.028,.11),(.45,.802,.29),black,.018)
# Bake bevels and join stationary geometry per material to keep real-time draw calls low.
for obj in list(bpy.context.scene.objects):
 bpy.context.view_layer.objects.active=obj
 for modifier in list(obj.modifiers):bpy.ops.object.modifier_apply(modifier=modifier.name)
for mat in [metal,black,light]:
 objects=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.materials and o.data.materials[0]==mat]
 bpy.ops.object.select_all(action='DESELECT')
 for obj in objects:obj.select_set(True)
 if objects:
  bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join()
out=sys.argv[sys.argv.index('--')+1]
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',export_apply=True,export_cameras=False,export_lights=False)
print('EXPORTED',out)
