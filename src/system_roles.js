const SYSTEM_ROLES={
 SUPER_ADMIN:{name:'Super Admin',permissions:['*']},
 OPERATIONS:{name:'Vận hành',permissions:['dashboard.view','bookings.view','drivers.view','users.view','matching.view','trust.view','trust.review','services.view','pricing.view','promotions.view','reports.view','payments.view','broadcast.view','settlement.view','merchants.view','merchants.manage','orders.view']},
 FINANCE:{name:'Tài chính',permissions:['dashboard.view','reports.view','payments.view','payments.manage','settlement.view','settlement.manage','pricing.view','merchants.view','orders.view']},
 PRICING:{name:'Giá & Thương mại',permissions:['services.view','services.manage','pricing.view','pricing.manage','promotions.view','promotions.manage','reports.view','merchants.view','merchants.manage','orders.view']},
 SUPPORT:{name:'Hỗ trợ',permissions:['dashboard.view','users.view','drivers.view','bookings.view','broadcast.view','trust.view','merchants.view','orders.view']},
};
function mergePermissions(current=[],required=[]){return [...new Set([...(current||[]),...(required||[])])];}
async function reconcileSystemRoles(db){const now=new Date();const changed=[];for(const [code,def] of Object.entries(SYSTEM_ROLES)){const existing=await db.collection('admin_roles').findOne({code});const permissions=code==='SUPER_ADMIN'?['*']:mergePermissions(existing?.permissions,def.permissions);await db.collection('admin_roles').updateOne({code},{$set:{name:existing?.name||def.name,permissions,status:'ACTIVE',system:true,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});if(existing&&JSON.stringify([...(existing.permissions||[])].sort())!==JSON.stringify([...permissions].sort()))changed.push(code);}if(changed.length)await db.collection('audit_logs').insertOne({actorType:'SYSTEM',action:'SYSTEM_ROLE_RECONCILE',entityType:'ADMIN_ROLE',entityId:changed.join(','),after:{changed},createdAt:now});return {ok:true,changed};}
module.exports={SYSTEM_ROLES,mergePermissions,reconcileSystemRoles};
