const input=document.querySelector('input'),status=document.querySelector('#status'),button=document.querySelector('button');
window.connection.savedHost().then(value=>input.value=value);
document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;status.textContent='Connecting…';try{const result=await window.connection.connect(input.value);if(result.error)status.textContent=result.error;}catch{status.textContent='Unable to connect. Check the host address.';}button.disabled=false;});
