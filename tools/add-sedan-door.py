import bpy, math
from mathutils import Vector
root=bpy.data.objects['Executive_Sedan']
body=bpy.data.objects['Sculpted aluminium body']
glass=bpy.data.objects['Glazed cabin']
# Separate the manufactured shell and glazing into a real hinged door.
bpy.ops.mesh.primitive_cube_add(size=1,location=(.94,.35,1.0))
cutter=bpy.context.object;cutter.name='Door tooling';cutter.dimensions=(.8,1.52,1.22)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
pivot=bpy.data.objects.new('Driver_door_hinge',None);bpy.context.collection.objects.link(pivot)
pivot.parent=root;pivot.location=(.84,1.11,.57)
for original,label in [(body,'Driver_door_panel'),(glass,'Driver_door_window')]:
    bpy.context.view_layer.objects.active=original
    for mod in list(original.modifiers): bpy.ops.object.modifier_apply(modifier=mod.name)
    part=original.copy();part.data=original.data.copy();bpy.context.collection.objects.link(part);part.name=label
    for key in list(part.keys()): del part[key]
    for obj,operation in [(part,'INTERSECT'),(original,'DIFFERENCE')]:
        m=obj.modifiers.new('Door aperture','BOOLEAN');m.object=cutter;m.operation=operation
        bpy.context.view_layer.objects.active=obj;bpy.ops.object.modifier_apply(modifier=m.name)
    world=part.matrix_world.copy();part.parent=pivot;part.matrix_world=world
bpy.data.objects.remove(cutter,do_unlink=True)
# Hollow the cabin floor volume to allow a seated adult inside.
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,1.14))
cutter=bpy.context.object;cutter.dimensions=(1.46,2.25,1.1)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
bpy.context.view_layer.objects.active=body
m=body.modifiers.new('Passenger footwell','BOOLEAN');m.object=cutter;m.operation='DIFFERENCE'
bpy.ops.object.modifier_apply(modifier=m.name);bpy.data.objects.remove(cutter,do_unlink=True)
def cube(name,loc,dim,material,parent=root):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=dim
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(bpy.data.materials[material])
    m=o.modifiers.new('Soft edges','BEVEL');m.width=.035;m.segments=3
    world=o.matrix_world.copy();o.parent=parent;o.matrix_world=world;return o
for x in [-.43,.43]:
    cube('Leather seat cushion',(x,-.12,.57),(.56,.61,.16),'Rubber sidewall')
    back=cube('Leather seat back',(x,-.40,.9),(.56,.14,.68),'Rubber sidewall');back.rotation_euler.x=-.13
    cube('Head restraint',(x,-.48,1.25),(.31,.12,.23),'Rubber sidewall')
cube('Driver door inner trim',(.858,.34,.79),(.045,1.36,.32),'Rubber sidewall',pivot)
cube('Driver armrest',(.80,.25,.85),(.14,.50,.07),'Rubber sidewall',pivot)
cube('Dashboard',(0,.88,.88),(1.36,.35,.21),'Rubber sidewall')
bpy.ops.mesh.primitive_torus_add(major_radius=.16,minor_radius=.021,location=(.43,.62,.99),rotation=(math.pi/2+.3,0,0))
o=bpy.context.object;o.name='Steering wheel';o.data.materials.append(bpy.data.materials['Rubber sidewall']);o.parent=root
for o in list(root.children):
    if (o.name.startswith('Flush door handle') and o.location.x>0 and o.location.y>0) or (o.name.startswith('Wing mirror') and o.location.x>0) or (o.name.startswith('Mirror lens') and o.location.x>0):
        world=o.matrix_world.copy();o.parent=pivot;o.matrix_world=world
scene=bpy.context.scene;scene.render.fps=30;scene.frame_start=1;scene.frame_end=91
for frame,angle in [(1,0),(25,1.08),(55,1.08),(91,0)]:
    pivot.rotation_euler.z=angle;pivot.keyframe_insert(data_path='rotation_euler',frame=frame)
scene.frame_set(1)
# Preview from the driver's side with the aperture open.
scene.frame_set(35)
scene.camera.location=(6.5,7,3.5);scene.camera.rotation_euler=(Vector((0,0,.7))-scene.camera.location).to_track_quat('-Z','Y').to_euler()
scene.render.resolution_x=900;scene.render.resolution_y=600;scene.render.resolution_percentage=100
scene.render.image_settings.media_type='IMAGE';scene.render.image_settings.file_format='PNG'
target=artifacts.file(name='sedan-driver-door.png',media_type='image/png');scene.render.filepath=str(target.path)
bpy.ops.render.render(write_still=True);target.publish()
scene.frame_set(1)
result={'hinge':pivot.name,'seatHeight':.65,'doorOpeningRadians':1.08,'previewFrame':35}
