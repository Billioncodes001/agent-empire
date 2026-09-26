"""Add original Rocketbox motion clips to the shipped rigs. Blender 4.5+.
World-space retargeting follows dgreenheck/tidewater/tools/characters/convert.py (MIT).
Usage: blender -b --python tools/retarget-motion.py -- input.glb output.glb clips.fbx...
"""
import bpy,sys,os
args=sys.argv[sys.argv.index('--')+1:];source,out=args[:2];clips=args[2:]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene;scene.render.fps=30
bpy.ops.import_scene.gltf(filepath=source)
arm=next(o for o in bpy.data.objects if o.type=='ARMATURE')
arm.animation_data_create()
for a in bpy.data.actions:a.use_fake_user=True
# Preserve the original clips, but make their layers inactive while baking.
if arm.animation_data.action:
    act=arm.animation_data.action
    if not any(st.action==act for tr in arm.animation_data.nla_tracks for st in tr.strips):
        tr=arm.animation_data.nla_tracks.new();tr.name=act.name;tr.strips.new(act.name,0,act)
arm.animation_data.action=None
for tr in arm.animation_data.nla_tracks:tr.mute=True
rest=arm.matrix_world.copy()
for path in clips:
    before=set(bpy.data.objects);before_actions=set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path,use_anim=True,automatic_bone_orientation=False,ignore_leaf_bones=False)
    imported=[o for o in bpy.data.objects if o not in before]
    clip_arm=next(o for o in imported if o.type=='ARMATURE')
    act=clip_arm.animation_data.action;start,end=map(int,act.frame_range)
    name=os.path.basename(path).split('.')[0][2:]
    arm.matrix_world=rest
    for pb in arm.pose.bones:
        if pb.name not in clip_arm.pose.bones:continue
        c=pb.constraints.new('COPY_ROTATION');c.target=clip_arm;c.subtarget=pb.name;c.owner_space='WORLD';c.target_space='WORLD'
        if pb.name=='Bip01 Pelvis':
            c=pb.constraints.new('COPY_LOCATION');c.target=clip_arm;c.subtarget=pb.name;c.owner_space='WORLD';c.target_space='WORLD'
            # The controller supplies displacement; retain recorded hip height and foot contacts.
            c.use_x=False;c.use_y=False;c.use_z=True
    for o in bpy.context.view_layer.objects:o.select_set(False)
    arm.select_set(True);bpy.context.view_layer.objects.active=arm
    bpy.ops.object.mode_set(mode='POSE');bpy.ops.pose.select_all(action='SELECT')
    bpy.ops.nla.bake(frame_start=start,frame_end=end,only_selected=True,visual_keying=True,clear_constraints=True,use_current_action=False,bake_types={'POSE'})
    bpy.ops.object.mode_set(mode='OBJECT')
    baked=arm.animation_data.action;baked.name=name;baked.use_fake_user=True;arm.animation_data.action=None
    for o in imported:bpy.data.objects.remove(o,do_unlink=True)
    for a in list(bpy.data.actions):
        if a not in before_actions and a!=baked:bpy.data.actions.remove(a)
    tr=arm.animation_data.nla_tracks.new();tr.name=name
    st=tr.strips.new(name,start,baked)
    if hasattr(st,'action_slot') and baked.slots:st.action_slot=baked.slots[0]
    tr.mute=True
    print('BAKED',name,start,end,flush=True)
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=out,export_format='GLB',export_image_format='AUTO',export_jpeg_quality=88,export_skins=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_optimize_animation_size=True,export_def_bones=False,export_morph=False,export_yup=True,export_apply=False,export_cameras=False,export_lights=False)
print('EXPORTED',out,os.path.getsize(out),flush=True)
