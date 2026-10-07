const jwt=require('jsonwebtoken');
function createAdminGuard({getDb}){
  function jwtSecret(){const s=String(process.env.JWT_ACCESS_SECRET||'').trim();if(s.length<32)throw new Error('JWT_ACCESS_SECRET chưa an toàn.');return s;}
  async function requireAdmin(req,res,next){try{const h=String(req.headers.authorization||'');if(!h.startsWith('Bearer '))return res.status(401).json({message:'Thiếu Access Token quản trị.'});const payload=jwt.verify(h.slice(7).trim(),jwtSecret());const {ObjectId}=require('mongodb');let id;try{id=new ObjectId(String(payload.sub||payload.userId));}catch(_){return res.status(401).json({message:'Access Token không hợp lệ.'});}const user=await getDb().collection('users').findOne({_id:id,roles:'ADMIN'});if(!user)return res.status(403).json({message:'Không có quyền ADMIN.'});const codes=Array.isArray(user.adminRoleCodes)?user.adminRoleCodes:Array.isArray(user.roleCodes)?user.roleCodes:[];if(!codes.length||codes.includes('SUPER_ADMIN'))req.adminPermissions=['*'];else{const roles=await getDb().collection('admin_roles').find({code:{$in:codes},status:'ACTIVE'}).toArray();req.adminPermissions=[...new Set(roles.flatMap(x=>Array.isArray(x.permissions)?x.permissions:[]))];}req.admin=user;next();}catch(e){return res.status(401).json({message:'Phiên quản trị không hợp lệ.'});}}
  const permit=permission=>(req,res,next)=>req.adminPermissions?.includes('*')||req.adminPermissions?.includes(permission)?next():res.status(403).json({message:`Thiếu quyền ${permission}.`});
  return {requireAdmin,permit};
}
module.exports={createAdminGuard};
