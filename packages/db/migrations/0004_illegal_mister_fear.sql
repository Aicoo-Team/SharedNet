ALTER TABLE "sharednet"."message" DROP CONSTRAINT "message_room_fk";
--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" DROP CONSTRAINT "room_member_room_fk";
--> statement-breakpoint
ALTER TABLE "sharednet"."message" ADD CONSTRAINT "message_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharednet"."room_member" ADD CONSTRAINT "room_member_room_fk" FOREIGN KEY ("room_id") REFERENCES "sharednet"."room"("id") ON DELETE cascade ON UPDATE no action;