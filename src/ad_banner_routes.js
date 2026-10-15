'use strict';
// Separate marketing banners from transactional discount rules.
// Media is stored in MongoDB GridFS, never embedded in JSON documents.
const express = require('express');
const multer = require('multer');
const { GridFSBucket, ObjectId } = require('mongodb');
const { createAdminGuard } = require('./admin_guard');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
const collectionName = 'ad_banners';
const baseRoute = '/api/v181/banners';

function validImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}
function safeObjectId(value) { try { return new ObjectId(String(value)); } catch (_) { return null; } }
function publicBanner(doc) {
  return {
    id: String(doc._id), title: doc.title || '', subtitle: doc.subtitle || '',
    description: doc.description || '', promotionCode: doc.promotionCode || '',
    imageUrl: doc.imageFileId ? `${baseRoute}/media/${doc.imageFileId}` : '',
    enabled: Boolean(doc.enabled), sortOrder: Number(doc.sortOrder || 0),
    startAt: doc.startAt || null, endAt: doc.endAt || null,
    updatedAt: doc.updatedAt || null,
  };
}
function isCurrent(doc, now) {
  return doc.enabled === true && (!doc.startAt || doc.startAt <= now) && (!doc.endAt || doc.endAt > now);
}
function clean(input, prior = {}) {
  const title = String(input.title ?? prior.title ?? '').trim().slice(0,120);
  if (!title) throw new Error('Bạn cần nhập tiêu đề banner.');
  const startRaw = input.startAt === undefined ? prior.startAt : input.startAt;
  const endRaw = input.endAt === undefined ? prior.endAt : input.endAt;
  const startAt = startRaw ? new Date(startRaw) : null;
  const endAt = endRaw ? new Date(endRaw) : null;
  if ((startAt && !Number.isFinite(startAt.valueOf())) || (endAt && !Number.isFinite(endAt.valueOf()))) {
    throw new Error('Ngày bắt đầu hoặc kết thúc không hợp lệ.');
  }
  if (startAt && endAt && endAt <= startAt) throw new Error('Ngày kết thúc phải sau ngày bắt đầu.');
  const sortOrder = Number(input.sortOrder ?? prior.sortOrder ?? 0);
  if (!Number.isFinite(sortOrder) || sortOrder < 0 || sortOrder > 9999) throw new Error('Thứ tự không hợp lệ.');
  const promotionCode = String(input.promotionCode ?? prior.promotionCode ?? '').trim().toUpperCase().slice(0,50);
  if (promotionCode && !/^[A-Z0-9_-]+$/.test(promotionCode)) throw new Error('Mã khuyến mãi không hợp lệ.');
  return {
    title, subtitle:String(input.subtitle ?? prior.subtitle ?? '').trim().slice(0,200),
    description:String(input.description ?? prior.description ?? '').trim().slice(0,6000),
    promotionCode, enabled: Boolean(input.enabled ?? prior.enabled ?? false),
    startAt, endAt, sortOrder:Math.round(sortOrder),
  };
}
function createAdBannerPublicRouter({getDb}) {
  const r = express.Router();
  // Public deployment smoke-test; does not require Mongo or expose admin data.
  r.get('/status', (_req, res) => res.set('Cache-Control', 'no-store').json({ok:true,feature:'ad-banners',apiVersion:'v181',patch:'v21'}));
  r.get('/', async (_req,res) => {
    try {
      const now = new Date();
      const docs = await getDb().collection(collectionName).find({
        enabled:true,
        $and:[{$or:[{startAt:null},{startAt:{$exists:false}},{startAt:{$lte:now}}]},
              {$or:[{endAt:null},{endAt:{$exists:false}},{endAt:{$gt:now}}]}],
      }).sort({sortOrder:1,createdAt:-1}).limit(20).toArray();
      return res.set('Cache-Control','no-store').json({ok:true,banners:docs.map(publicBanner)});
    } catch (error) { return res.status(503).json({message:'Không tải được banner.'}); }
  });
  r.get('/media/:id', async (req,res) => {
    const fileId=safeObjectId(req.params.id);if(!fileId)return res.sendStatus(404);
    try {
      // Media is accessible via unguessable file ID for Admin previews, including drafts.
      // Only active/scheduled banners are discoverable from the public list.
      const banner=await getDb().collection(collectionName).findOne({imageFileId:String(fileId)});
      if(!banner) return res.sendStatus(404);
      const bucket=new GridFSBucket(getDb(),{bucketName:'imove_banner_media'});
      const files=await bucket.find({_id:fileId}).limit(1).toArray();
      if(!files.length)return res.sendStatus(404);
      const mime=files[0].metadata?.contentType;
      if(!['image/png','image/jpeg','image/webp'].includes(mime))return res.sendStatus(415);
      res.set({'Content-Type':mime,'Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'cross-origin'});
      bucket.openDownloadStream(fileId).on('error',()=>{if(!res.headersSent)res.sendStatus(404);else res.destroy();}).pipe(res);
    } catch (_) { if(!res.headersSent)res.sendStatus(503); }
  });
  return r;
}
function createAdBannerAdminRouter({getDb}) {
  const r = express.Router();
  const {requireAdmin,permit}=createAdminGuard({getDb});
  r.use(requireAdmin);
  r.get('/',permit('promotions.view'),async(_req,res)=>{
    try {const docs=await getDb().collection(collectionName).find({}).sort({sortOrder:1,createdAt:-1}).limit(200).toArray();return res.json({ok:true,banners:docs.map(publicBanner)});}
    catch(_){return res.status(503).json({message:'Không tải được danh sách banner.'});}
  });
  r.post('/',permit('promotions.manage'),async(req,res)=>{
    try {
      const doc=clean(req.body||{});
      if(doc.enabled)return res.status(400).json({message:'Hãy tải ảnh banner trước khi bật hiển thị.'});
      if(doc.promotionCode && !(await getDb().collection('promotions').findOne({code:doc.promotionCode})))return res.status(400).json({message:'Mã khuyến mãi liên kết không tồn tại.'});
      const now=new Date();
      const inserted=await getDb().collection(collectionName).insertOne({...doc,imageFileId:null,createdAt:now,updatedAt:now,updatedBy:req.admin._id});
      return res.status(201).json({ok:true,banner:publicBanner({...doc,_id:inserted.insertedId,updatedAt:now})});
    }catch(error){return res.status(400).json({message:error.message});}
  });
  r.put('/:id',permit('promotions.manage'),async(req,res)=>{
    const id=safeObjectId(req.params.id);if(!id)return res.sendStatus(404);
    try {
      const old=await getDb().collection(collectionName).findOne({_id:id});if(!old)return res.sendStatus(404);
      const update=clean(req.body||{},old);
      if(update.enabled&&!old.imageFileId)return res.status(400).json({message:'Hãy tải ảnh banner trước khi bật hiển thị.'});
      if(update.promotionCode && !(await getDb().collection('promotions').findOne({code:update.promotionCode})))return res.status(400).json({message:'Mã khuyến mãi liên kết không tồn tại.'});
      const now=new Date();
      await getDb().collection(collectionName).updateOne({_id:id},{$set:{...update,updatedAt:now,updatedBy:req.admin._id}});
      return res.json({ok:true,banner:publicBanner({...old,...update,updatedAt:now})});
    }catch(error){return res.status(400).json({message:error.message});}
  });
  r.post('/:id/image',permit('promotions.manage'),(req,res,next)=>{
    upload.single('banner')(req,res,(err)=>{
      if(err)return res.status(400).json({message:err.code==='LIMIT_FILE_SIZE'?'Ảnh banner tối đa 5 MB.':'Tệp ảnh không hợp lệ.'});
      next();
    });
  },async(req,res)=>{
    const id=safeObjectId(req.params.id);if(!id)return res.sendStatus(404);
    if(!req.file)return res.status(400).json({message:'Chưa chọn ảnh banner.'});
    const mime=validImage(req.file.buffer);
    if(!mime)return res.status(415).json({message:'Chỉ hỗ trợ ảnh PNG, JPG và WebP.'});
    try {
      const db=getDb();const collection=db.collection(collectionName);
      const old=await collection.findOne({_id:id});if(!old)return res.sendStatus(404);
      const bucket=new GridFSBucket(db,{bucketName:'imove_banner_media'});
      const fileId=await new Promise((resolve,reject)=>{
        const stream=bucket.openUploadStream('banner',{metadata:{contentType:mime,bannerId:String(id)}});
        stream.on('error',reject);stream.on('finish',()=>resolve(stream.id));stream.end(req.file.buffer);
      });
      try {await collection.updateOne({_id:id},{$set:{imageFileId:String(fileId),updatedAt:new Date(),updatedBy:req.admin._id}});}
      catch(error){await bucket.delete(fileId).catch(()=>{});throw error;}
      if(old.imageFileId){const prev=safeObjectId(old.imageFileId);if(prev)await bucket.delete(prev).catch(()=>{});}
      const changed=await collection.findOne({_id:id});
      return res.json({ok:true,banner:publicBanner(changed)});
    }catch(_){return res.status(503).json({message:'Không lưu được ảnh vào MongoDB GridFS.'});}
  });
  r.delete('/:id',permit('promotions.manage'),async(req,res)=>{
    const id=safeObjectId(req.params.id);if(!id)return res.sendStatus(404);
    try {
      const old=await getDb().collection(collectionName).findOneAndDelete({_id:id});if(!old)return res.sendStatus(404);
      if(old.imageFileId){const mediaId=safeObjectId(old.imageFileId);if(mediaId)await new GridFSBucket(getDb(),{bucketName:'imove_banner_media'}).delete(mediaId).catch(()=>{});}
      return res.json({ok:true});
    } catch(_){return res.status(503).json({message:'Không thể xóa banner.'});}
  });
  return r;
}
module.exports={createAdBannerPublicRouter,createAdBannerAdminRouter,publicBanner,clean,validImage,isCurrent};
