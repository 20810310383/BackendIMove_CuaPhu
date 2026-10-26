'use strict';
const express=require('express');
const {ObjectId}=require('mongodb');
const {createAdminGuard}=require('./admin_guard');
function oid(v){try{return new ObjectId(String(v));}catch{return null}}
function createDriverPointLedgerAdminRouter({getDb}){
 const r=express.Router();const {requireAdmin,permit}=createAdminGuard({getDb});
 r.use(requireAdmin,permit('drivers.view'));
 r.get('/drivers/:id/ledger',async(req,res)=>{
  try{
   const driverId=oid(req.params.id);if(!driverId)return res.status(400).json({message:'Driver ID không hợp lệ.'});
   const db=getDb();const driver=await db.collection('drivers').findOne({_id:driverId});
   if(!driver)return res.status(404).json({message:'Không tìm thấy tài xế.'});
   const limit=Math.max(1,Math.min(200,Number(req.query.limit)||100));
   const [account,transactions]=await Promise.all([
     db.collection('driver_reward_accounts').findOne({driverId}),
     db.collection('driver_reward_transactions').find({driverId}).sort({createdAt:-1}).limit(limit).toArray(),
   ]);
   const ids=[...new Set(transactions.map(t=>String(t.bookingId||t.sourceBookingId||'')).filter(Boolean))].map(oid).filter(Boolean);
   const bookings=ids.length?await db.collection('bookings').find({_id:{$in:ids}}).project({bookingCode:1,status:1,pricing:1,fareSnapshot:1,completedAt:1}).toArray():[];
   const byId=new Map(bookings.map(b=>[String(b._id),b]));
   const finished=await db.collection('bookings').find({driverId,status:'COMPLETED'})
     .project({_id:1,bookingCode:1,status:1,pricing:1,fareSnapshot:1}).sort({completedAt:-1,createdAt:-1}).limit(200).toArray();
   const recordedFeeRows=finished.length ? await db.collection('driver_reward_transactions').find({
     sourceTransactionId:{$in:finished.map(b=>`PLATFORM_FEE:${String(b._id)}`)},driverId,
   }).project({sourceTransactionId:1}).toArray():[];
   const recorded=new Set(recordedFeeRows.map(t=>String(t.sourceTransactionId||'').replace(/^PLATFORM_FEE:/,'')));
   const missingFeeBookings=finished.filter(b=>{
     const fee=Number(b.fareSnapshot?.platformCommission??b.pricing?.platformCommission??0);
     return fee>0 && !recorded.has(String(b._id));
   }).map(b=>({bookingId:String(b._id),bookingCode:b.bookingCode||null,
     expectedPlatformFeeVnd:Number(b.fareSnapshot?.platformCommission??b.pricing?.platformCommission??0)}));
   const items=transactions.map(t=>{
     const id=String(t.bookingId||t.sourceBookingId||''), booking=byId.get(id);
     return {id:String(t._id),type:t.type||'',points:Number(t.points||0),amountVnd:Number(t.amountVnd||0),
       reason:t.reason||t.title||'',reference:t.reference||t.sourceTransactionId||'',
       bookingId:id||null,bookingCode:booking?.bookingCode||null,bookingStatus:booking?.status||null,
       platformFeeVnd:Number(booking?.fareSnapshot?.platformCommission??booking?.pricing?.platformCommission??t.amountVnd??0),
       createdAt:t.createdAt,balanceAfter:t.balanceAfter??null};
   });
   res.json({driverId:String(driverId),balance:Number(account?.balance||0),lifetimeEarned:Number(account?.lifetimeEarned||0),lifetimeSpent:Number(account?.lifetimeSpent||0),
     missingFeeBookings,feeDebits:items.filter(t=>t.type==='PLATFORM_FEE'),adminAdjustments:items.filter(t=>t.type==='ADMIN_ADJUSTMENT'),transactions:items});
  }catch(e){res.status(500).json({message:'Không đọc được sổ điểm tài xế.'})}
 });
 return r;
}
module.exports={createDriverPointLedgerAdminRouter};
